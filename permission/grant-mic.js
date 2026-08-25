// permission/grant-mic.js
//
// One-time microphone grant for the extension origin. The side panel can't
// show Chrome's mic permission prompt itself, but a regular extension page in
// a tab can — once granted here, webkitSpeechRecognition works in the side
// panel too (same chrome-extension:// origin). No manifest permission needed:
// getUserMedia from an extension page only requires the user's consent via
// this prompt ("audioCapture" is a Chrome-Apps permission, not for extensions).

const grantBtn = document.getElementById("grant");
const status = document.getElementById("status");

grantBtn.addEventListener("click", async () => {
  status.textContent = "";
  status.className = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the permission, not the stream — release the mic at once.
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = "Microphone enabled ✓ — you can close this tab and return to the side panel.";
    status.className = "ok";
    grantBtn.disabled = true;
  } catch (err) {
    status.className = "err";
    if (err.name === "NotAllowedError") {
      status.textContent =
        "Microphone access was blocked. To fix it: click the 🔒/⚙ icon in the address bar, " +
        "set Microphone to Allow for this extension, then press the button again.";
    } else {
      status.textContent = `Couldn't access the microphone: ${err.name} — is one connected?`;
    }
  }
});
