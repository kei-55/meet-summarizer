let logs = [];
let apiKey = "";

// APIキー読み込み
chrome.storage.local.get(["geminiApiKey"], res => {
  apiKey = res.geminiApiKey || "";
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 発言ログ保存
  if (msg.type === "LOG") {
    logs.push(msg.text);
    return;
  }

  // APIキー保存
  if (msg.type === "SET_API_KEY") {
    apiKey = msg.key;
    chrome.storage.local.set({ geminiApiKey: apiKey });
    return;
  }

  // ログクリア
  if (msg.type === "CLEAR") {
    logs = [];
    return;
  }

  // 要約
  if (msg.type === "SUMMARIZE") {
    summarize().then(summary => {
      sendResponse({ summary });
    });
    return true; // async response
  }
});

async function summarize() {
  if (!apiKey) return "❌ Gemini APIキーが設定されていません";
  if (logs.length === 0) return "⚠ 発言ログがありません";

  const prompt = `
以下はオンライン会議の発言ログです。
重要事項・決定事項・TODOを日本語で箇条書きで要約してください。

${logs.join("\n")}
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await res.json();
    return (
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "❌ 要約に失敗しました"
    );

  } catch (e) {
    return "❌ 通信エラー";
  }
}
