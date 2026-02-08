const result = document.getElementById("result");

document.getElementById("openOptions").onclick = () => {
  chrome.runtime.openOptionsPage();
};

function getMeetingKeyFromActiveTab(tab) {
  try {
    const url = new URL(tab.url);
    const m = url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return m?.[1] || url.pathname.replace(/\W+/g, "_") || "unknown";
  } catch {
    return "unknown";
  }
}

document.getElementById("summarizeNow").onclick = async () => {
  result.textContent = "要約中…（完了するとDownloadsに保存されます）";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://meet.google.com/")) {
    result.textContent = "Google Meetタブを開いてから実行してください。";
    return;
  }

  const meetingKey = getMeetingKeyFromActiveTab(tab);

  chrome.runtime.sendMessage(
    { type: "SUMMARIZE_NOW", meetingKey },
    (res) => {
      if (!res) {
        result.textContent = "失敗しました（応答なし）";
        return;
      }
      if (!res.ok) {
        result.textContent = res.error || "失敗しました";
        return;
      }
      result.textContent =
        `✅ 保存しました（Downloads）\n` +
        `- ${res.item.files.summaryFile}\n` +
        `- ${res.item.files.fullFile}\n\n` +
        `--- 要約 ---\n${res.item.summary}`;
    }
  );
};

function renderLatest(item) {
  if (!item) {
    result.textContent = "まだ要約がありません。";
    return;
  }
  result.textContent =
    `最新の要約（${item.createdAt}）\n` +
    `meetingKey: ${item.meetingKey}\n` +
    `- ${item.files?.summaryFile || ""}\n` +
    `- ${item.files?.fullFile || ""}\n\n` +
    `--- 要約 ---\n${item.summary || ""}`;
}

function loadLatestSummary() {
  chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (res) => {
    if (!res?.ok) return;
    const items = res.summaries || [];
    if (items.length === 0) return;
    renderLatest(items[0]);
  });
}

loadLatestSummary();
