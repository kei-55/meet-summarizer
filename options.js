const apiKeyInput = document.getElementById("apiKey");
const statusEl = document.getElementById("status");
const authStatusEl = document.getElementById("authStatus");

document.getElementById("toggle").onclick = () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  document.getElementById("toggle").textContent = apiKeyInput.type === "password" ? "表示" : "非表示";
};

chrome.storage.local.get(["geminiApiKey"], (res) => {
  // 値は画面共有で見えにくいよう password 入力に入れるだけ（表示はしない）
  if (res.geminiApiKey) apiKeyInput.value = res.geminiApiKey;
});

document.getElementById("save").onclick = () => {
  chrome.storage.local.set({ geminiApiKey: apiKeyInput.value }, () => {
    statusEl.textContent = "✅ 保存しました";
  });
};

document.getElementById("testAuth").onclick = () => {
  authStatusEl.textContent = "認可中…";
  chrome.runtime.sendMessage({ type: "AUTH_TEST" }, (res) => {
    if (!res?.ok) {
      authStatusEl.textContent = res?.error || "❌ 認可に失敗しました";
      return;
    }
    authStatusEl.textContent = "✅ 認可OK（Googleドキュメントに保存できます）";
  });
};
