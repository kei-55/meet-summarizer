const result = document.getElementById("result");
const recordBadge = document.getElementById("recordBadge");
const logCountNum = document.getElementById("logCountNum");
const speakerCountEl = document.getElementById("speakerCount");
const speakerCountNum = document.getElementById("speakerCountNum");
const panelDate = document.getElementById("panelDate");
const participantsEl = document.getElementById("participants");

document.getElementById("openOptions").onclick = () => {
  chrome.runtime.openOptionsPage();
};

function formatDateJa(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${mo}/${da} ${h}:${mi}`;
}

function getMeetingKeyFromActiveTab(tab) {
  try {
    const url = new URL(tab.url);
    const m = url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return m?.[1] || url.pathname.replace(/\W+/g, "_") || "unknown";
  } catch {
    return "unknown";
  }
}

async function getActiveMeetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isMeet = !!tab?.url?.startsWith("https://meet.google.com/");
  return { tab, isMeet };
}

// 現在のMeetタブのログ状態を確認してステータスバーを更新
async function refreshStatus() {
  const { tab, isMeet } = await getActiveMeetTab();

  if (!isMeet) {
    recordBadge.className = "badge idle";
    recordBadge.innerHTML = '<span class="badge-dot"></span>Meet以外';
    return;
  }

  const meetingKey = getMeetingKeyFromActiveTab(tab);
  chrome.runtime.sendMessage({ type: "GET_LOG_STATUS", meetingKey }, (res) => {
    const count = res?.count || 0;
    const speakers = res?.speakers || [];

    logCountNum.textContent = count;

    if (count > 0) {
      recordBadge.className = "badge recording";
      recordBadge.innerHTML = '<span class="badge-dot"></span>録音中';

      if (speakers.length > 0) {
        speakerCountEl.style.display = "";
        speakerCountNum.textContent = speakers.length;
      }
    } else {
      recordBadge.className = "badge idle";
      recordBadge.innerHTML = '<span class="badge-dot"></span>待機中';
    }
  });
}

document.getElementById("summarizeNow").onclick = async () => {
  result.textContent = "要約中…（完了するとDownloadsに保存されます）";
  participantsEl.style.display = "none";

  const { tab, isMeet } = await getActiveMeetTab();
  if (!isMeet) {
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
      renderLatest(res.item);
      refreshStatus();
    }
  );
};

document.getElementById("refreshStatus").onclick = refreshStatus;

function renderLatest(item) {
  if (!item) {
    result.textContent = "まだ要約がありません。";
    panelDate.textContent = "";
    participantsEl.style.display = "none";
    return;
  }

  panelDate.textContent = formatDateJa(item.createdAt);

  if (item.participants?.length > 0) {
    participantsEl.style.display = "";
    participantsEl.innerHTML = "参加者: " + item.participants.map(p => `<span>${p}</span>`).join("、");
  } else {
    participantsEl.style.display = "none";
  }

  result.textContent =
    `📁 ${item.files?.summaryFile || ""}\n` +
    `📁 ${item.files?.fullFile || ""}\n\n` +
    `${item.summary || ""}`;
}

function loadLatestSummary() {
  chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (res) => {
    if (!res?.ok) return;
    const items = res.summaries || [];
    renderLatest(items[0] || null);
  });
}

loadLatestSummary();
refreshStatus();
