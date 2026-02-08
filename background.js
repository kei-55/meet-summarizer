// background.js (MV3 Service Worker) - Summarize only on meeting end

let logsByMeeting = {}; // { [meetingKey]: string[] }

chrome.storage.local.get(["logsByMeeting"], (res) => {
  logsByMeeting = res.logsByMeeting || {};
  console.log("📂 logsByMeeting restored:", Object.keys(logsByMeeting).length);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const meetingKey = msg.meetingKey || "unknown";

  // 発言ログ保存（重複防止 + 上限制）
  if (msg.type === "LOG") {
    const arr = (logsByMeeting[meetingKey] ||= []);
    const last = arr.at(-1);
    if (last !== msg.text) {
      arr.push(msg.text);

      // 無料運用：最大300件
      const MAX_LOGS = 300;
      if (arr.length > MAX_LOGS) logsByMeeting[meetingKey] = arr.slice(-MAX_LOGS);

      chrome.storage.local.set({ logsByMeeting });
      console.log("🗣 LOG saved:", meetingKey, msg.text);
    }
    return;
  }

  // APIキー保存
  if (msg.type === "SET_API_KEY") {
    chrome.storage.local.set({ geminiApiKey: msg.key }, () => {
      console.log("🔑 API Key saved");
    });
    return;
  }

  // 全クリア
  if (msg.type === "CLEAR") {
    logsByMeeting = {};
    chrome.storage.local.remove(["logsByMeeting", "lastSummary"], () => {
      console.log("🧹 cleared");
    });
    return;
  }

  // 会議終了 → 自動要約（ここだけGemini呼ぶ）
  if (msg.type === "END_MEETING") {
    summarizeMeeting(meetingKey, msg.reason || "unknown").then((summaryObj) => {
      sendResponse(summaryObj);
    });
    return true;
  }

  // ポップアップ用：最新要約を取得
  if (msg.type === "GET_LAST_SUMMARY") {
    chrome.storage.local.get(["lastSummary"], (res) => {
      sendResponse({ lastSummary: res.lastSummary || null });
    });
    return true;
  }

  // デバッグ用：モデル一覧
  if (msg.type === "LIST_MODELS") {
    listModels().then((result) => sendResponse(result));
    return true;
  }
});

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
      console.log("📚 ListModels response from", ep.api, data);

      if (Array.isArray(data.models)) {
        const supported = data.models
          .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map(m => m.name);

        return { ok: true, apiVersion: ep.api, models: supported };
      }
    } catch (e) {
      console.error("ListModels failed:", ep.api, e);
    }
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

async function summarizeMeeting(meetingKey, reason) {
  const { geminiApiKey } = await chrome.storage.local.get(["geminiApiKey"]);
  if (!geminiApiKey) return { ok: false, error: "❌ Gemini APIキーが設定されていません" };

  const logs = logsByMeeting[meetingKey] || [];
  if (logs.length === 0) return { ok: false, error: "⚠ 発言ログがありません" };

  // 無料運用：最後の120行だけ要約
  const clipped = logs.slice(-120);

  // 実在モデルを自動検出
  const lm = await listModels();
  if (!lm.ok) return { ok: false, error: lm.error || "❌ モデル一覧取得に失敗" };
  if (!lm.models?.length) return { ok: false, error: "❌ generateContent対応モデルが見つかりません" };

  // Flash優先（無料運用向け）
  const modelName = lm.models.find(n => n.includes("flash")) || lm.models[0];
  const apiVersion = lm.apiVersion;

  const prompt = `
以下はオンライン会議の発言ログです。
会議終了後の議事録として、次の形式で日本語で要約してください。

# 概要（3行）
# 決定事項
- ...
# TODO
- ...（担当/期限が分かれば）
# 未解決・懸念
- ...

【発言ログ】
${clipped.join("\n")}
`;

  const url = `https://generativelanguage.googleapis.com/${apiVersion}/${modelName}:generateContent?key=${geminiApiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
      })
    });

    const data = await res.json();
    console.log("🧠 Using model:", apiVersion, modelName, "reason:", reason);
    console.log("📦 Gemini response:", data);

    if (data.error) {
      return { ok: false, error: `❌ Gemini error: ${data.error.message || JSON.stringify(data.error)}` };
    }

    const summaryText = extractText(data);
    if (!summaryText) return { ok: false, error: "❌ 要約テキスト抽出に失敗" };

    const lastSummary = {
      meetingKey,
      reason,
      createdAt: new Date().toISOString(),
      model: `${apiVersion}/${modelName}`,
      summary: summaryText
    };

    await chrome.storage.local.set({ lastSummary });

    // 会議終了後はログを軽くするため削除（無料運用向け）
    delete logsByMeeting[meetingKey];
    await chrome.storage.local.set({ logsByMeeting });

    return { ok: true, lastSummary };
  } catch (e) {
    console.error(e);
    return { ok: false, error: "❌ 通信エラー" };
  }
}
