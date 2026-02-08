// background.js (MV3) - summarize on end + save to Google Docs + history

let logsByMeeting = {};
chrome.storage.local.get(["logsByMeeting"], (res) => {
  logsByMeeting = res.logsByMeeting || {};
  console.log("📂 logsByMeeting restored:", Object.keys(logsByMeeting).length);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const meetingKey = msg.meetingKey || "unknown";

  if (msg.type === "LOG") {
    const arr = (logsByMeeting[meetingKey] ||= []);
    const last = arr.at(-1);
    if (last !== msg.text) {
      arr.push(msg.text);
      const MAX_LOGS = 300;
      if (arr.length > MAX_LOGS) logsByMeeting[meetingKey] = arr.slice(-MAX_LOGS);
      chrome.storage.local.set({ logsByMeeting });
      console.log("🗣 LOG saved:", meetingKey, msg.text);
    }
    return;
  }

  if (msg.type === "CLEAR") {
    logsByMeeting = {};
    chrome.storage.local.remove(["logsByMeeting", "lastSummary", "summaries"], () => {
      console.log("🧹 cleared");
    });
    return;
  }

  if (msg.type === "GET_LAST_SUMMARY") {
    chrome.storage.local.get(["lastSummary"], (res) => {
      sendResponse({ lastSummary: res.lastSummary || null });
    });
    return true;
  }

  if (msg.type === "GET_SUMMARY_LIST") {
    chrome.storage.local.get(["summaries"], (res) => {
      sendResponse({ summaries: res.summaries || [] });
    });
    return true;
  }

  if (msg.type === "AUTH_TEST") {
    getAuthToken(true).then((token) => {
      if (!token) sendResponse({ ok: false, error: "❌ 認可に失敗しました（OAuth設定を確認）" });
      else sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "END_MEETING") {
    summarizeAndSave(meetingKey, msg.reason || "unknown").then((out) => sendResponse(out));
    return true;
  }
});

async function pushSummaryToHistory(summaryObj) {
  const { summaries = [] } = await chrome.storage.local.get(["summaries"]);
  const next = [summaryObj, ...summaries];
  const MAX = 20;
  if (next.length > MAX) next.length = MAX;
  await chrome.storage.local.set({ summaries: next });
}

async function listModels() {
  const { geminiApiKey } = await chrome.storage.local.get(["geminiApiKey"]);
  if (!geminiApiKey) return { ok: false, error: "❌ Gemini APIキーが設定されていません" };

  const endpoints = [
    { api: "v1", url: `https://generativelanguage.googleapis.com/v1/models?key=${geminiApiKey}` },
    { api: "v1beta", url: `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}` }
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url);
      const data = await res.json();
      if (Array.isArray(data.models)) {
        const supported = data.models
          .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map(m => m.name);
        return { ok: true, apiVersion: ep.api, models: supported };
      }
    } catch {}
  }
  return { ok: false, error: "❌ ListModelsで利用可能モデルが取得できませんでした" };
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map(p => p?.text || "").join("").trim();
    if (t) return t;
  }
  return "";
}

function preprocessLogs(rawLogs) {
  return rawLogs
    .map(line => line.replace(/\s+/g, " ").trim())
    .map(line => line.replace(/^(あなた|自分|me)\s*/i, "あなた: "))
    .filter(line => line.length >= 2)
    .filter(line => !["うん", "はい", "えー", "あー", "なるほど", "了解", "OK"].includes(line));
}

async function summarizeAndSave(meetingKey, reason) {
  const { geminiApiKey } = await chrome.storage.local.get(["geminiApiKey"]);
  if (!geminiApiKey) return { ok: false, error: "❌ Gemini APIキーが設定されていません" };

  const logs = logsByMeeting[meetingKey] || [];
  if (logs.length === 0) return { ok: false, error: "⚠ 発言ログがありません" };

  // ① 要約用は最後150行（無料運用）
  const clipped = preprocessLogs(logs).slice(-150);

  const lm = await listModels();
  if (!lm.ok) return { ok: false, error: lm.error };
  const modelName = lm.models.find(n => n.includes("flash")) || lm.models[0];
  const apiVersion = lm.apiVersion;

  const prompt = `
あなたは「会議議事録の要約係」です。
以下の発言ログから、会議終了後に読むための要約を作ってください。

ルール:
- 雑談・相槌は極力省略
- 技術的な内容 / 決定事項 / 依頼事項 / TODO を最優先
- 発言者名が曖昧な場合は「あなた」「他参加者」に統合（推測で個人名を作らない）
- 不明点は「未確定」と書く
- 出力は必ずMarkdown

出力フォーマット（厳守）:
## 概要（3行）
- ...
## 決定事項
- ...
## 依頼・要望
- ...
## TODO
- [ ] ...（担当: あなた/他参加者, 期限: あれば）
## 未解決・懸念
- ...

発言ログ:
${clipped.join("\n")}
`;

  const url = `https://generativelanguage.googleapis.com/${apiVersion}/${modelName}:generateContent?key=${geminiApiKey}`;

  let summaryText = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
      })
    });
    const data = await res.json();
    if (data.error) return { ok: false, error: `❌ Gemini error: ${data.error.message}` };
    summaryText = extractText(data);
    if (!summaryText) return { ok: false, error: "❌ 要約テキスト抽出に失敗" };
  } catch (e) {
    return { ok: false, error: "❌ Gemini通信エラー" };
  }

  // ② Googleドキュメントに「要約 + 全文ログ」を保存
  const fullTranscript = preprocessLogs(logs).join("\n"); // 全文（最大300件）
  const createdAt = new Date().toISOString();
  const title = `Meet議事録_${meetingKey}_${createdAt.slice(0,19).replace(/[:T]/g,"-")}`;

  const docBody =
`# 会議議事録（Meet）
- meetingKey: ${meetingKey}
- createdAt: ${createdAt}

---

${summaryText}

---

## 全文ログ
${fullTranscript}
`;

  const docRes = await saveToGoogleDoc(title, docBody);

  const summaryObj = {
    id: crypto.randomUUID(),
    meetingKey,
    reason,
    createdAt,
    model: `${apiVersion}/${modelName}`,
    summary: summaryText,
    docUrl: docRes?.docUrl || null
  };

  await chrome.storage.local.set({ lastSummary: summaryObj });
  await pushSummaryToHistory(summaryObj);

  // 会議終了後はログを削除（軽量化）
  delete logsByMeeting[meetingKey];
  await chrome.storage.local.set({ logsByMeeting });

  if (!docRes?.ok) {
    // 要約は成功しているがDocs保存だけ失敗、という形で返す
    return { ok: true, summary: summaryObj, warning: docRes?.error || "Docs保存に失敗しました" };
  }

  return { ok: true, summary: summaryObj };
}

/* ---------------- Google OAuth + Docs/Drive ---------------- */

function getAuthToken(interactive) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) resolve(null);
      else resolve(token);
    });
  });
}

// DriveでGoogleドキュメント作成 → Docs APIで本文挿入
async function saveToGoogleDoc(title, text) {
  const token = await getAuthToken(true);
  if (!token) return { ok: false, error: "❌ Google認可が取れません（optionsの認可テストを確認）" };

  // 1) Drive API: Googleドキュメント作成
  let fileId = null;
  try {
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.document"
      })
    });
    const createData = await createRes.json();
    fileId = createData.id;
    if (!fileId) return { ok: false, error: "❌ Driveでドキュメント作成に失敗" };
  } catch {
    return { ok: false, error: "❌ Drive API 通信エラー" };
  }

  // 2) Docs API: 本文挿入（先頭にinsertText）
  try {
    const docId = fileId;
    const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text
            }
          }
        ]
      })
    });
    const updateData = await updateRes.json();
    if (updateData.error) return { ok: false, error: `❌ Docs更新失敗: ${updateData.error.message}` };

    return { ok: true, docUrl: `https://docs.google.com/document/d/${docId}/edit` };
  } catch {
    return { ok: false, error: "❌ Docs API 通信エラー" };
  }
}
