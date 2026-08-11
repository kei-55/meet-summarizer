// background.js (MV3 service worker)
// - Meetの発言ログを会議ごとに蓄積
// - 会議終了(or手動)でGemini要約
// - 要約と全文ログをローカル（Downloads配下）へテキスト保存
// - 保存先：Downloads配下のサブフォルダ名を設定可能 + saveAs(毎回保存先ダイアログ)

let logsByMeeting = {}; // { meetingKey: [ {ts, text, speaker?} ] }
let summaries = [];     // history list [{id, meetingKey, createdAt, summary, fullTextCount, files}]

const MAX_LOGS_PER_MEETING = 3000; // メモリ暴走防止
const MAX_HISTORY = 50;            // 履歴保存上限

console.log("background.js loaded");

(async function boot() {
  const stored = await chrome.storage.local.get(["logsByMeeting", "summaries"]);
  logsByMeeting = stored.logsByMeeting || {};
  summaries = stored.summaries || [];
  console.log("📂 logs restored:", Object.keys(logsByMeeting).length);
  console.log("📚 summaries restored:", summaries.length);
})();

// ---- storage save (debounce) ----
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await chrome.storage.local.set({ logsByMeeting, summaries });
  }, 1000);
}

// ---- util ----
function nowIso() {
  return new Date().toISOString();
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function fileStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}${mo}${da}-${h}${mi}${s}`;
}
function safeName(str) {
  return (str || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

// ---- settings ----
async function getApiKey() {
  const { geminiApiKey } = await chrome.storage.local.get(["geminiApiKey"]);
  return geminiApiKey || "";
}
async function getSaveSettings() {
  const { saveFolder, saveAs } = await chrome.storage.local.get(["saveFolder", "saveAs"]);
  return {
    saveFolder: (saveFolder || "").trim() || "MeetSummarizer",
    saveAs: !!saveAs
  };
}
function normalizeSubdir(name) {
  // Windows互換寄せ：危険文字除去
  return (name || "")
    .replace(/[\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// ---- Gemini ----
async function listModels(apiKey) {
  // v1 の ListModels
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("📚 ListModels response:", data);
  if (!Array.isArray(data.models)) return [];
  return data.models.map(m => m.name).filter(Boolean);
}

function pickModel(modelNames) {
  const prefer = [
    "models/gemini-2.5-flash",
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-pro"
  ];
  for (const p of prefer) {
    if (modelNames.includes(p)) return p;
  }
  const flash = modelNames.find(n => n.includes("flash") && n.startsWith("models/"));
  if (flash) return flash;
  return modelNames.find(n => n.startsWith("models/")) || "models/gemini-1.5-flash";
}

async function summarizeText(apiKey, meetingKey, fullLogs) {
  const modelNames = await listModels(apiKey);
  const model = pickModel(modelNames);
  console.log("🧠 Using model:", model);

  const participants = Array.from(
    new Set(fullLogs.map(x => (x.speaker || "").trim()).filter(Boolean))
  );

  // プロンプト（必要ならここを改善していく）
  const joined = fullLogs
    .map(x => x.speaker ? `- ${x.speaker}: ${x.text}` : `- ${x.text}`)
    .join("\n")
    .slice(0, 140000); // 念のため上限制御（雑）

  const prompt = `
以下はオンライン会議の発言ログです。
あなたは議事録担当です。重要事項・決定事項・TODOを日本語で箇条書きで要約してください。
雑談は省き、技術/決定/依頼を優先してください。
不明点は「不明」として書き、推測しないでください。
参加者名が分かる場合は、要約の先頭に「参加者: ...」として記載してください。

【会議キー】${meetingKey}

【参加者候補】
${participants.length ? participants.map(p => `- ${p}`).join("\n") : "- （不明）"}

【発言ログ】
${joined}
`;

  const url = `https://generativelanguage.googleapis.com/v1/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
    })
  });

  const data = await res.json();
  console.log("📦 Gemini response:", data);

  const text =
    data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ||
    data.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  return { text, modelUsed: model, participants };
}

// ---- download ----
async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return `data:text/plain;charset=utf-8;base64,${base64}`;
}

function toCrlf(text) {
  // Windowsのメモ帳など、LF単独だと改行が反映されず全文が1行に見えるアプリ対策
  return String(text).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

async function downloadText(filename, text, overrideSettings = null) {
  const baseSettings = await getSaveSettings();
  const { saveFolder, saveAs, subdir } = overrideSettings
    ? {
        saveFolder: overrideSettings.saveFolder,
        saveAs: overrideSettings.saveAs,
        subdir: overrideSettings.subdir
      }
    : baseSettings;
  const baseDir = normalizeSubdir(saveFolder);
  const extraDir = normalizeSubdir(subdir);
  const fullDir = [baseDir, extraDir].filter(Boolean).join("/");
  const finalName = fullDir ? `${fullDir}/${filename}` : filename;

  return new Promise((resolve, reject) => {
    (async () => {
      const dataUrl = await blobToDataUrl(new Blob([toCrlf(text)], { type: "text/plain;charset=utf-8" }));
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: finalName,
          saveAs,
          conflictAction: "uniquify"
        },
        (downloadId) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(err);
            return;
          }
          chrome.downloads.search({ id: downloadId }, (items) => {
            const err2 = chrome.runtime.lastError;
            if (err2) {
              resolve({ downloadId, filename: finalName });
              return;
            }
            const found = (items || [])[0];
            resolve({ downloadId, filename: found?.filename || finalName });
          });
        }
      );
    })().catch(reject);
  });
}

// ---- finalize meeting ----
async function finalizeMeeting(meetingKey) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "❌ Gemini APIキーが設定されていません" };

  const logs = logsByMeeting[meetingKey] || [];
  if (logs.length === 0) return { ok: false, error: "⚠ 発言ログがありません" };

  const { text: summary, modelUsed, participants } = await summarizeText(apiKey, meetingKey, logs);
  if (!summary) return { ok: false, error: "❌ 要約に失敗しました（応答が空です）" };

  const stamp = fileStamp();
  const safeKey = safeName(meetingKey);
  const base = `meet_${safeKey}_${stamp}`;
  const folderName = base;

  const fullText = logs.map(x => {
    const speaker = x.speaker ? `${x.speaker}: ` : "";
    return `${x.ts} ${speaker}${x.text}`;
  }).join("\n");

  const summaryFile = `summary.txt`;
  const fullFile = `full.txt`;

  const { saveFolder, saveAs } = await getSaveSettings();
  const overrideSettings = {
    saveFolder,
    saveAs,
    subdir: folderName
  };

  const summaryResult = await downloadText(
    summaryFile,
    summary.trim() + "\n",
    overrideSettings
  );
  const fullResult = await downloadText(
    fullFile,
    fullText.trim() + "\n",
    overrideSettings
  );

  const item = {
    id: `${meetingKey}_${stamp}`,
    meetingKey,
    createdAt: nowIso(),
    summary: summary.trim(),
    fullTextCount: logs.length,
    files: {
      summaryFile: `${folderName}/${summaryFile}`,
      fullFile: `${folderName}/${fullFile}`,
      summaryDownloadId: summaryResult.downloadId,
      fullDownloadId: fullResult.downloadId,
      summaryPath: summaryResult.filename,
      fullPath: fullResult.filename
    },
    modelUsed,
    participants: participants || []
  };

  summaries.unshift(item);
  if (summaries.length > MAX_HISTORY) summaries = summaries.slice(0, MAX_HISTORY);

  // 会議終了後はメモリ解放
  delete logsByMeeting[meetingKey];

  scheduleSave();

  return { ok: true, item };
}

async function openPopupAfterSummary() {
  try {
    if (!chrome.action?.openPopup) return;
    const win = await chrome.windows.getLastFocused();
    await chrome.action.openPopup({ windowId: win?.id });
  } catch (e) {
    console.log("⚠ openPopup failed:", e);
  }
}

// ---- message handler ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // 発言ログ保存
      if (msg.type === "LOG") {
        const { meetingKey, text, speaker } = msg;
        if (!meetingKey || !text) return;

        const arr = (logsByMeeting[meetingKey] ||= []);
        const last = arr.at(-1)?.text;

        if (last !== text) {
          arr.push({ ts: nowIso(), text, speaker: speaker || "" });
          if (arr.length > MAX_LOGS_PER_MEETING) {
            arr.splice(0, arr.length - MAX_LOGS_PER_MEETING);
          }
          console.log("🗣 LOG saved:", meetingKey, speaker || "-", text);
          scheduleSave();
        }
        return;
      }

      // APIキー保存
      if (msg.type === "SET_API_KEY") {
        await chrome.storage.local.set({ geminiApiKey: msg.key || "" });
        console.log("🔑 API Key saved");
        sendResponse({ ok: true });
        return;
      }

      // 保存先設定（options側から使う場合）
      if (msg.type === "SET_SAVE_SETTINGS") {
        const saveFolder = (msg.saveFolder || "MeetSummarizer").trim();
        const saveAs = !!msg.saveAs;
        await chrome.storage.local.set({ saveFolder, saveAs });
        sendResponse({ ok: true });
        return;
      }

      // 履歴取得（options用）
      if (msg.type === "GET_HISTORY") {
        sendResponse({ ok: true, summaries });
        return;
      }

      // 全クリア
      if (msg.type === "CLEAR_ALL") {
        logsByMeeting = {};
        summaries = [];
        await chrome.storage.local.set({ logsByMeeting, summaries });
        sendResponse({ ok: true });
        return;
      }

      // 手動要約
      if (msg.type === "SUMMARIZE_NOW") {
        const meetingKey = msg.meetingKey;
        const result = await finalizeMeeting(meetingKey);
        sendResponse(result);
        return;
      }

      // 会議終了検知 → 自動要約
      if (msg.type === "MEETING_ENDED") {
        const meetingKey = msg.meetingKey;
        const result = await finalizeMeeting(meetingKey);
        if (result.ok) await openPopupAfterSummary();
        sendResponse(result);
        return;
      }

      sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      console.error("❌ background error:", e);
      sendResponse({ ok: false, error: `❌ エラー: ${e?.message || e}` });
    }
  })();

  return true; // async
});
