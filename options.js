const keyInput = document.getElementById("key");
const saveFolderInput = document.getElementById("saveFolder");
const saveAsCheckbox = document.getElementById("saveAs");
const saveStatus = document.getElementById("saveStatus");
const list = document.getElementById("list");
const searchInput = document.getElementById("search");
const clearSearchBtn = document.getElementById("clearSearch");
const historyStatus = document.getElementById("historyStatus");

let lastItems = [];
let lastById = {};

function setStatus(msg) {
  saveStatus.textContent = msg;
  setTimeout(() => (saveStatus.textContent = ""), 3000);
}

function setHistoryStatus(msg) {
  historyStatus.textContent = msg;
  setTimeout(() => (historyStatus.textContent = ""), 3000);
}

// 初期表示
chrome.storage.local.get(["geminiApiKey", "saveFolder", "saveAs"], res => {
  if (res.geminiApiKey) keyInput.value = res.geminiApiKey;
  saveFolderInput.value = (res.saveFolder || "MeetSummarizer");
  saveAsCheckbox.checked = !!res.saveAs;
});

document.getElementById("toggle").onclick = () => {
  keyInput.type = keyInput.type === "password" ? "text" : "password";
};

// APIキー保存
document.getElementById("saveKey").onclick = () => {
  chrome.runtime.sendMessage({ type: "SET_API_KEY", key: keyInput.value }, () => {
    setStatus("✅ APIキーを保存しました");
  });
};

// 保存フォルダ名保存
document.getElementById("saveFolderBtn").onclick = () => {
  const saveFolder = (saveFolderInput.value || "").trim() || "MeetSummarizer";
  chrome.storage.local.set({ saveFolder }, () => {
    setStatus(`✅ 保存先を Downloads/${saveFolder}/ に設定しました`);
  });
};

// saveAs保存
document.getElementById("saveAsBtn").onclick = () => {
  chrome.storage.local.set({ saveAs: saveAsCheckbox.checked }, () => {
    setStatus(saveAsCheckbox.checked
      ? "✅ 毎回「名前を付けて保存」を出す設定にしました"
      : "✅ 自動保存（Downloads配下）にしました"
    );
  });
};

async function refresh() {
  list.textContent = "読み込み中…";
  chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (res) => {
    if (!res?.ok) {
      list.textContent = "履歴取得に失敗しました";
      return;
    }
    const items = res.summaries || [];
    lastItems = items;
    renderList();
  });
}

function renderList() {
  const q = (searchInput.value || "").trim().toLowerCase();
  const items = q
    ? lastItems.filter(i => {
        const key = (i.meetingKey || "").toLowerCase();
        const date = (i.createdAt || "").toLowerCase();
        return key.includes(q) || date.includes(q);
      })
    : lastItems;

  lastById = {};
  items.forEach(i => { lastById[i.id] = i; });

  if (lastItems.length === 0) {
    list.textContent = "履歴はまだありません。";
    return;
  }

  if (q && items.length === 0) {
    list.textContent = "条件に一致する履歴がありません。";
    return;
  }

  list.innerHTML = items.map(item => {
    const files = item.files
      ? `${item.files.summaryFile}<br>${item.files.fullFile}`
      : "";
    const summaryId = item.files?.summaryDownloadId;
    const fullId = item.files?.fullDownloadId;
    const summaryDisabled = summaryId ? "" : "disabled";
    const fullDisabled = fullId ? "" : "disabled";

    return `
      <div style="border:1px solid #ddd;padding:10px;border-radius:8px;margin-bottom:10px">
        <div><b>${item.createdAt}</b> / meetingKey: <code>${item.meetingKey}</code></div>
        <div style="font-size:12px;opacity:.8;margin-top:4px">保存ファイル名（Downloads配下）:<br>${files}</div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button data-action="copy-summary" data-id="${item.id}">要約コピー</button>
          <button data-action="open-summary" data-id="${item.id}" ${summaryDisabled}>要約ファイルを開く</button>
          <button data-action="open-full" data-id="${item.id}" ${fullDisabled}>全文ファイルを開く</button>
        </div>
        <pre style="white-space:pre-wrap;margin-top:8px">${escapeHtml(item.summary)}</pre>
      </div>
    `;
  }).join("");
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, s => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[s]));
}

document.getElementById("refresh").onclick = refresh;
searchInput.oninput = renderList;
clearSearchBtn.onclick = () => {
  searchInput.value = "";
  renderList();
};

document.getElementById("clearAll").onclick = () => {
  if (!confirm("ログと履歴を全て削除します。よろしいですか？")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_ALL" }, (res) => {
    if (res?.ok) refresh();
  });
};

list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id");
  const item = lastById[id];
  if (!item) return;

  if (action === "copy-summary") {
    const text = item.summary || "";
    try {
      await navigator.clipboard.writeText(text);
      setHistoryStatus("✅ 要約をコピーしました");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setHistoryStatus("✅ 要約をコピーしました");
    }
    return;
  }

  if (action === "open-summary" || action === "open-full") {
    const downloadId = action === "open-summary"
      ? item.files?.summaryDownloadId
      : item.files?.fullDownloadId;

    if (!downloadId) {
      setHistoryStatus("⚠ この履歴は古いためファイルを開けません");
      return;
    }

    chrome.downloads.open(downloadId, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        setHistoryStatus("⚠ ファイルを開けませんでした（削除済みの可能性）");
      }
    });
  }
});

refresh();
