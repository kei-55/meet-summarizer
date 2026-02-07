const keyInput = document.getElementById("key");
const result = document.getElementById("result");

// APIキー復元
chrome.storage.local.get(["geminiApiKey"], res => {
  if (res.geminiApiKey) {
    keyInput.value = res.geminiApiKey;
  }
});

// 保存
document.getElementById("save").onclick = () => {
  chrome.runtime.sendMessage({
    type: "SET_API_KEY",
    key: keyInput.value
  });
};

// 要約
document.getElementById("summarize").onclick = () => {
  result.textContent = "要約中…";
  chrome.runtime.sendMessage(
    { type: "SUMMARIZE" },
    res => {
      result.textContent = res.summary;
    }
  );
};

// クリア
document.getElementById("clear").onclick = () => {
  chrome.runtime.sendMessage({ type: "CLEAR" });
  result.textContent = "";
};
