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
  const stored = await chrome.storage.local.get(["saveFolder", "saveAs"]);
  return {
    saveFolder: stored.saveFolder || "MeetSummarizer",
    saveAs: !!stored.saveAs
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
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
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
      const dataUrl = await blobToDataUrl(new Blob([text], { type: "text/plain;charset=utf-8" }));
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

// ---- full.txt 再解析 ----

// テキスト全体からスピーカー名候補を検出（漢字含む or 英語大文字始まり）
function detectSpeakerNames(text) {
  const freq = new Map();
  for (const word of text.split(/\s+/)) {
    const clean = word.replace(/[。、！？…「」『』\.\!\?（）():：]/g, "").trim();
    if (clean.length < 2 || clean.length > 10) continue;
    // 漢字を含む（日本人名）か英語名（大文字始まり）のみ候補にする
    if (!/[\u4E00-\u9FAF]/.test(clean) && !/^[A-Z][a-z]/.test(clean)) continue;
    freq.set(clean, (freq.get(clean) || 0) + 1);
  }
  const stopWords = new Set([
    "フェーズ", "パターン", "システム", "ありがとう", "すみません", "よろしく",
    "お願い", "わかり", "ください", "比較表", "内容", "最新版", "担当", "対応",
    "確認", "設定", "作業", "資料", "会議", "参加者", "決定", "検討", "説明",
    "対象", "全体", "関係", "方針", "課題",
  ]);
  return Array.from(freq.entries())
    .filter(([w, count]) => count >= 2 && !stopWords.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w);
}

// 検出されたスピーカー名でテキストを発言単位に分割
function splitBySpeakers(text, speakers) {
  if (!speakers.length) return [{ speaker: "", text: text.trim() }];
  const escaped = speakers.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(^|\\s)(${escaped.join("|")})\\s`, "g");
  const parts = [];
  let lastIndex = 0;
  let lastSpeaker = "";
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const matchStart = match.index + match[1].length;
    const textBefore = text.slice(lastIndex, matchStart).trim();
    if (textBefore) parts.push({ speaker: lastSpeaker, text: textBefore });
    lastSpeaker = match[2];
    lastIndex = matchStart + match[2].length + 1;
  }
  const remaining = text.slice(lastIndex).trim();
  if (remaining) parts.push({ speaker: lastSpeaker, text: remaining });
  return parts.length ? parts : [{ speaker: "", text: text.trim() }];
}

// full.txt の内容をログ配列に変換（旧・新フォーマット両対応）
function parseFullTextContent(rawContent) {
  const lines = rawContent.trim().split("\n").filter(Boolean);
  const isOldFormat = lines.some(l => /^\d{4}-\d{2}-\d{2}T/.test(l));
  const isNewFormat = lines.some(l => /^\[\d{2}:\d{2}:\d{2}\]/.test(l));

  let speakers = [];
  if (isOldFormat && !isNewFormat) {
    // 全テキストを結合してスピーカー名を検出
    const allText = lines
      .map(l => { const m = l.match(/^\S+T\S+Z\s+(.*)/); return m ? m[1] : l; })
      .join(" ");
    speakers = detectSpeakerNames(allText);
    console.log("🔍 Detected speakers:", speakers);
  }

  const logs = [];
  for (const line of lines) {
    // 新フォーマット: [HH:MM:SS] Speaker: text
    const newMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(?:(.+?):\s)?(.+)$/);
    if (newMatch) {
      logs.push({
        ts: new Date().toISOString(),
        speaker: (newMatch[2] || "").trim(),
        text: newMatch[3].trim()
      });
      continue;
    }
    // 旧フォーマット（コロンあり）: ISO_TS Speaker: text
    const oldColon = line.match(/^(\S+T\S+Z)\s+(.{1,20}):\s+(.+)$/);
    if (oldColon) {
      logs.push({ ts: oldColon[1], speaker: oldColon[2].trim(), text: oldColon[3].trim() });
      continue;
    }
    // 旧フォーマット（コロンなし）: ISO_TS text（スピーカー名が内包）
    const oldPlain = line.match(/^(\S+T\S+Z)\s+(.+)$/);
    if (oldPlain) {
      const ts = oldPlain[1];
      const rest = oldPlain[2];
      const utterances = splitBySpeakers(rest, speakers);
      for (const u of utterances) {
        if (u.text) logs.push({ ts, speaker: u.speaker, text: u.text });
      }
      continue;
    }
    // タイムスタンプなし（プレーンテキスト）
    if (line.trim()) {
      logs.push({ ts: new Date().toISOString(), speaker: "", text: line.trim() });
    }
  }
  return logs;
}

function formatLogsAsFullText(logs) {
  return logs.map(x => {
    const d = new Date(x.ts);
    const timeStr = `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}]`;
    const speaker = x.speaker ? `${x.speaker}: ` : "";
    return `${timeStr} ${speaker}${x.text}`;
  }).join("\n");
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

  const fullText = formatLogsAsFullText(logs);

  const summaryFile = `summary.txt`;
  const fullFile = `full.txt`;

  const overrideSettings = {
    saveFolder: "MeetSummarizer",
    saveAs: false,
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

      // ログ状態取得（popup用）
      if (msg.type === "GET_LOG_STATUS") {
        const { meetingKey } = msg;
        const logs = logsByMeeting[meetingKey] || [];
        const speakers = Array.from(
          new Set(logs.map(x => (x.speaker || "").trim()).filter(Boolean))
        );
        sendResponse({ ok: true, count: logs.length, speakers });
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

      // full.txtから再要約
      if (msg.type === "RESUMMARIZE") {
        console.log("🔄 RESUMMARIZE received, meetingKey:", msg.meetingKey, "contentLength:", msg.rawContent?.length);
        const { rawContent, meetingKey } = msg;
        const apiKey = await getApiKey();
        if (!apiKey) {
          sendResponse({ ok: false, error: "❌ Gemini APIキーが設定されていません" });
          return;
        }
        if (!rawContent) {
          sendResponse({ ok: false, error: "⚠ ファイル内容が空です（ファイルの再選択をお試しください）" });
          return;
        }
        const logs = parseFullTextContent(rawContent);
        console.log("📝 Parsed logs count:", logs.length);
        if (!logs.length) {
          sendResponse({ ok: false, error: "⚠ ログを解析できませんでした（full.txtの形式を確認してください）" });
          return;
        }
        const { text: summary, modelUsed, participants } = await summarizeText(apiKey, meetingKey, logs);
        if (!summary) {
          sendResponse({ ok: false, error: "❌ 要約に失敗しました（応答が空です）" });
          return;
        }

        const stamp = fileStamp();
        const safeKey = safeName(meetingKey);
        const base = `meet_${safeKey}_${stamp}_re`;

        // 整形済み full.txt（新フォーマット）
        const reformattedFull = formatLogsAsFullText(logs);

        const baseSettings = await getSaveSettings();
        const overrideSettings = {
          saveFolder: baseSettings.saveFolder,
          saveAs: baseSettings.saveAs,
          subdir: base
        };
        const summaryResult = await downloadText("summary.txt", summary.trim() + "\n", overrideSettings);
        const fullResult = await downloadText("full.txt", reformattedFull.trim() + "\n", overrideSettings);

        const item = {
          id: `${meetingKey}_${stamp}_re`,
          meetingKey,
          createdAt: nowIso(),
          summary: summary.trim(),
          fullTextCount: logs.length,
          files: {
            summaryFile: `${base}/summary.txt`,
            fullFile: `${base}/full.txt`,
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
        scheduleSave();
        sendResponse({ ok: true, item });
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
