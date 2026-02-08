const keyInput = document.getElementById("key");
const result = document.getElementById("result");

function showSummary(obj) {
  if (!obj) {
    result.textContent = "（まだ要約がありません。会議を退出すると自動で作られます）";
    return;
  }
  result.textContent =
    `【meetingKey】${obj.meetingKey}\n` +
    `【createdAt】${obj.createdAt}\n` +
    `【model】${obj.model}\n\n` +
    obj.summary;
}

// APIキー復元
chrome.storage.local.get(["geminiApiKey"], (res) => {
  if (res.geminiApiKey) keyInput.value = res.geminiApiKey;
});

// 起動時：最新要約表示
chrome.runtime.sendMessage({ type: "GET_LAST_SUMMARY" }, (res) => {
  showSummary(res?.lastSummary || null);
});

// 保存
document.getElementById("save").onclick = () => {
  chrome.runtime.sendMessage({ type: "SET_API_KEY", key: keyInput.value });
};

// 全消去
document.getElementById("clear").onclick = () => {
  chrome.runtime.sendMessage({ type: "CLEAR" });
  result.textContent = "（全ログを消去しました）";
};

// 最新要約
document.getElementById("refresh").onclick = () => {
  chrome.runtime.sendMessage({ type: "GET_LAST_SUMMARY" }, (res) => {
    showSummary(res?.lastSummary || null);
  });
};

// コピー
document.getElementById("copy").onclick = async () => {
  const text = result.textContent || "";
  if (!text.trim()) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
};
