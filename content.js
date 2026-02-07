console.log("Meet Caption Logger loaded (diff)");

let lastText = "";

const observer = new MutationObserver(() => {
  const region = document.querySelector(
    'div[role="region"][aria-label="字幕"]'
  );

  if (!region) return;

  const current = region.innerText
    .replace(/\n+/g, " ")
    .trim();

  if (!current || current === lastText) return;

  if (current.startsWith(lastText)) {
    const diff = current.slice(lastText.length).trim();
    if (diff) {
      console.log("🗣 発言:", diff);
    }
  } else {
    console.log("🗣 発言:", current);
  }

  lastText = current;
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
