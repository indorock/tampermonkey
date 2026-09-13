// ==UserScript==
// @name         Reddit - Force Mark Unread Messages Read
// @namespace    mark-old-reddit-read
// @version      3.0
// @description  Works around old.reddit.com's unread count not clearing after using the new UI's mark-as-read. Sends the same POST to /api/read_message that a manual click already sends, batched across everything unread.
// @match        https://old.reddit.com/message/unread*
// @match        https://www.reddit.com/message/unread*
// @match        https://reddit.com/message/unread*
// @match        https://old.reddit.com/message/inbox*
// @match        https://www.reddit.com/message/inbox*
// @match        https://reddit.com/message/inbox*
// @connect      old.reddit.com
// @connect      www.reddit.com
// @grant        GM_xmlhttpRequest
// @icon         https://www.google.com/s2/favicons?sz=64&domain=reddit.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
console.log("HHHHH");
  // Where we read the unread listing from. Stays old.reddit.com regardless
  // of which of the three pages above the script is running on, since
  // that's the host carrying the legacy unread flag we're working around.
  const BASE_URL = 'https://old.reddit.com';
  // Where the actual mark-as-read call goes. Confirmed from the real
  // request a manual click sends: it's www.reddit.com even from the old
  // UI, a different host than the one above.
  const API_HOST = 'https://www.reddit.com';
  const BATCH_SIZE = 25;    // Reddit's cap on ids per read_message call
  // How long to wait between each batch. Raise this if Reddit starts
  // returning 429s, lower it if you're impatient and it's working fine.
  const DELAY_MS = 600;
  const PAGE_LIMIT = 100;   // Reddit's max per page of the unread listing
  const MAX_ITEMS = 2000;   // sanity cap, just in case something loops

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // GM_xmlhttpRequest runs at the extension level, not the page's, so it
  // isn't subject to the page's CORS restrictions. That matters because
  // this script may be running on www.reddit.com or bare reddit.com (Reddit
  // redirects old.reddit.com there for some accounts), and because the
  // mark-as-read call itself targets a different host than the listing
  // does. Your reddit session cookie is shared across all of *.reddit.com,
  // so it still goes through authenticated either way.
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function gmPost(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        data: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function fetchUnreadPage(after) {
    const url = new URL(`${BASE_URL}/message/unread/.json`);
    url.searchParams.set('limit', PAGE_LIMIT);
    if (after) url.searchParams.set('after', after);
    const res = await gmGet(url.toString());
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Unread listing request failed: ${res.status}`);
    }
    return JSON.parse(res.responseText);
  }

  async function collectAllUnread() {
    let items = [];
    let after = null;
    while (items.length < MAX_ITEMS) {
      const json = await fetchUnreadPage(after);
      const children = json && json.data && json.data.children ? json.data.children : [];
      if (children.length === 0) break;
      items = items.concat(children);
      after = json.data.after;
      if (!after) break;
    }
    return items;
  }

  // The modhash is Reddit's CSRF token for write requests, tied to your
  // logged-in session. It's not secret, just something the page exposes
  // to itself so its own JS can use it, we're grabbing it the same way
  // the page's own code would.
  function getModhash() {
    const uhInput = document.querySelector('input[name="uh"]');
    if (uhInput && uhInput.value) return uhInput.value;
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.r && unsafeWindow.r.config) {
        const mh = unsafeWindow.r.config.modhash;
        if (mh) return mh;
      }
    } catch (e) {
      // ignore, fall through to the next method
    }
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const match = s.textContent.match(/"modhash"\s*:\s*"([0-9a-f]+)"/);
      if (match) return match[1];
    }
    return null;
  }

  async function markBatchRead(fullnames, modhash) {
    const body = `id=${encodeURIComponent(fullnames.join(','))}&uh=${encodeURIComponent(modhash)}&renderstyle=html`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await gmPost(`${API_HOST}/api/read_message`, body);
        if (res.status >= 200 && res.status < 300) return true;
        if (res.status === 429) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        return false;
      } catch (e) {
        await sleep(800 * (attempt + 1));
      }
    }
    return false;
  }

  function getOrMakePanel() {
    let panel = document.getElementById('mark-all-read-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'mark-all-read-panel';
    panel.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      background: #1a1a1b; color: #d7dadc; font: 12px/1.4 arial, sans-serif;
      padding: 10px 14px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.4);
      max-width: 260px; cursor: pointer; user-select: none;
    `;
    panel.textContent = 'mark all unread read';
    panel.addEventListener('click', () => runMarkAllRead());
    document.body.appendChild(panel);
    return panel;
  }

  async function runMarkAllRead() {
    const panel = getOrMakePanel();
    const modhash = getModhash();
    if (!modhash) {
      panel.textContent = 'Could not find your modhash on this page. Reload the page and try again.';
      return;
    }
    panel.textContent = 'Fetching unread messages…';
    let items;
    try {
      items = await collectAllUnread();
    } catch (e) {
      panel.textContent = `Failed to fetch unread list: ${e.message}`;
      return;
    }
    if (items.length === 0) {
      panel.textContent = 'Nothing unread. Done. (click to run again)';
      return;
    }
    const fullnames = items.map((child) => child.data.name).filter(Boolean);
    const batches = chunk(fullnames, BATCH_SIZE);
    let done = 0;
    let failed = 0;
    for (const batch of batches) {
      panel.textContent = `Marking read: ${done} / ${fullnames.length}`;
      const ok = await markBatchRead(batch, modhash);
      if (ok) done += batch.length; else failed += batch.length;
      await sleep(DELAY_MS);
    }
    panel.textContent = `Done. Marked ${done} read${failed ? `, ${failed} failed` : ''}. Refresh to see the count update. (click to run again)`;
  }

  // Callable from the devtools console too, same effect as clicking
  // the floating panel.
  window.markAllRedditRead = runMarkAllRead;

  getOrMakePanel();
})();
