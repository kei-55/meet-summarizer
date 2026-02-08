const result = document.getElementById("result");
const historyDiv = document.getElementById("history");

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function showSummary(obj) {
  if (!obj) {
    result.textContent = "（まだ要約がありません。会議を退出すると自動で作られます）";
    return;
  }

  result.textContent =
    `【meetingKey】${obj.meetingKey}\n` +
    `【createdAt】${fmtDate(obj.createdAt)}\n` +
    `【model】${obj.model}\n` +
    (obj.docUrl ? `【Google Doc】${obj.docUrl}\n\n` : "\n") +
    obj.summary;
}

function loadLastSummary() {
  chrome.runtime.sendMessage({ type: "GET_LAST_SUMMARY" }, (res) => {
    showSummary(res?.lastSummary || null);
  });
}

function loadHistory() {
  chrome.runtime.sendMessage({ type: "GET_SUMMARY_LIST" }, (res) => {
    const list = res?.summaries || [];
    if (!list.length) {
      historyDiv.textContent = "（履歴はまだありません）";
      return;
    }

    historyDiv.innerHTML = "";
    list.forEach((s) => {
      const item = document.createElement("div");
      item.style.padding = "6px";
      item.style.borderBottom = "1px solid #eee";
      item.style.cursor = "pointer";

      const title = document.createElement("div");
      title.style.fontWeight = "bold";
      title.textContent = `${fmtDate(s.createdAt)} / ${s.meetingKey}`;

      const preview = document.createElement("div");
      preview.style.fontSize = "12px";
      preview.style.opacity = "0.8";
      preview.style.marginTop = "2px";
      preview.textContent = (s.summary || "").split("\n").slice(0, 2).join(" ").slice(0, 120);

      const link = document.createElement("div");
      link.style.fontSize = "12px";
      link.style.marginTop = "4px";
      if (s.docUrl) {
        link.textContent = "Google Docを開く";
        link.style.color = "#1a73e8";
        link.style.textDecoration = "underline";
        link.onclick = (e) => {
          e.stopPropagation();
          chrome.tabs.create({ url: s.docUrl });
        };
      } else {
        link.textContent = "（Doc未保存）";
        link.style.opacity = "0.6";
      }

      item.appendChild(title);
      item.appendChild(preview);
      item.appendChild(link);

      item.onclick = () => showSummary(s);
      historyDiv.appendChild(item);
    });
  });
}

document.getElementById("openSettings").onclick = () => {
  chrome.runtime.openOptionsPage();
};

document.getElementById("clear").onclick = () => {
  chrome.runtime.sendMessage({ type: "CLEAR" });
  result.textContent = "（全消去しました）";
  historyDiv.textContent = "（履歴はまだありません）";
};

document.getElementById("refresh").onclick = () => {
  loadLastSummary();
  loadHistory();
};

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

loadLastSummary();
loadHistory();
