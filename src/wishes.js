import './wishes.css';

const STORAGE_PREFIX = 'pillow.photo-tree.wishes.v1';
const RESET_EVENT = 'pillow-wishes-reset';
const TOTAL = 3;
const keyFor = (index) => `${STORAGE_PREFIX}.${index}`;
const focusableSelector = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function readState() {
  try {
    const redeemed = Array.from({ length: TOTAL }, (_, index) => {
      const raw = window.localStorage.getItem(keyFor(index));
      if (raw === null) return false;
      const item = JSON.parse(raw);
      if (item?.version !== 1 || item.redeemed !== true || !Number.isFinite(item.redeemedAt) || typeof item.claim !== 'string') {
        throw new Error('Invalid wish state');
      }
      return true;
    });
    // A partial/corrupt ledger must never silently restore a used wish.
    if (redeemed.some((used, index) => used && redeemed.slice(0, index).some((prior) => !prior))) {
      throw new Error('Invalid wish order');
    }
    return { used: redeemed.filter(Boolean).length, available: true };
  } catch {
    return { used: 0, available: false };
  }
}

/** Development only. Attach to a developer object only when ?debug=1 is present. */
export function resetWishes() {
  try {
    for (let index = 0; index < TOTAL; index += 1) window.localStorage.removeItem(keyFor(index));
    window.dispatchEvent(new Event(RESET_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function createWishes({ onOpen = () => {}, onClose = () => {}, onUse = () => {}, onToast = () => {} } = {}) {
  let unlocked = false;
  let opened = false;
  let destroyed = false;
  let confirmationOpen = false;
  let submitting = false;
  let expectedUsed = 0;
  let state = readState();
  let returnFocus = null;
  let modalReturnFocus = null;
  let bodyOverflow = '';
  let siblingStates = [];
  let animationFrame = 0;
  let closeTimer = 0;

  const root = document.createElement('section');
  root.className = 'wish-experience';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'wish-title');
  root.innerHTML = `
    <div class="wish-ambient" aria-hidden="true"></div>
    <button class="wish-back" type="button" aria-label="返回照片树"><span aria-hidden="true">←</span> 返回星空</button>
    <div class="wish-card">
      <div class="wish-crest" aria-hidden="true">✦</div>
      <p class="wish-edition">A LITTLE MAGIC · THREE WISHES</p>
      <h1 id="wish-title">枕头专属补偿券</h1>
      <div class="wish-rule" aria-hidden="true"></div>
      <h2>三次愿望兑换权</h2>
      <p class="wish-description">枕头拥有 <strong>3 次愿望</strong>。<br>每次可以要求本人完成一件事情。</p>
      <p class="wish-command">不得忤逆。</p>
      <dl class="wish-terms">
        <div><dt>时间：</dt><dd>枕头决定</dd></div>
        <div><dt>地点：</dt><dd>枕头决定</dd></div>
        <div><dt>有效期：</dt><dd>长期有效</dd></div>
      </dl>
      <div class="wish-hearts" aria-label="三次愿望">
        <button class="wish-heart" type="button" data-wish="0" aria-label="使用第 1 次愿望">❤️</button>
        <button class="wish-heart" type="button" data-wish="1" aria-label="使用第 2 次愿望">❤️</button>
        <button class="wish-heart" type="button" data-wish="2" aria-label="使用第 3 次愿望">❤️</button>
      </div>
      <p class="wish-count" role="status" aria-live="polite">剩余愿望：<strong>3 / 3</strong></p>
      <p class="wish-storage-message" role="status" hidden>当前浏览器暂时无法保存愿望状态，请稍后再试。</p>
      <p class="wish-footnote">最终解释权归枕头所有。</p>
    </div>
    <div class="wish-confirm-backdrop" hidden>
      <div class="wish-confirm" role="dialog" aria-modal="true" aria-labelledby="wish-confirm-title">
        <span class="wish-confirm-star" aria-hidden="true">✦</span>
        <h2 id="wish-confirm-title">确定使用一次愿望吗？</h2>
        <p>这颗心会被记住。</p>
        <div class="wish-confirm-actions">
          <button type="button" class="wish-cancel">再想想</button>
          <button type="button" class="wish-accept">确定使用</button>
        </div>
      </div>
    </div>`;
  document.body.append(root);

  const card = root.querySelector('.wish-card');
  const back = root.querySelector('.wish-back');
  const hearts = [...root.querySelectorAll('.wish-heart')];
  const count = root.querySelector('.wish-count strong');
  const storageMessage = root.querySelector('.wish-storage-message');
  const backdrop = root.querySelector('.wish-confirm-backdrop');
  const confirmation = root.querySelector('.wish-confirm');
  const cancel = root.querySelector('.wish-cancel');
  const accept = root.querySelector('.wish-accept');

  function render() {
    hearts.forEach((heart, index) => {
      const used = index < state.used;
      heart.textContent = used ? '🖤' : '❤️';
      heart.disabled = used || !state.available || submitting;
      heart.classList.toggle('is-used', used);
      heart.setAttribute('aria-label', used ? `第 ${index + 1} 次愿望已使用` : `使用第 ${index + 1} 次愿望`);
    });
    count.textContent = state.available ? `${TOTAL - state.used} / ${TOTAL}` : '— / 3';
    storageMessage.hidden = state.available;
    accept.disabled = submitting;
    cancel.disabled = submitting;
  }

  function restoreFocus(element, fallback) {
    if (element?.isConnected && !element.disabled && !element.closest('[hidden]')) element.focus({ preventScroll: true });
    else fallback?.focus({ preventScroll: true });
  }

  function closeConfirmation({ restore = true } = {}) {
    if (!confirmationOpen) return;
    confirmationOpen = false;
    backdrop.hidden = true;
    card.inert = false;
    back.inert = false;
    if (restore) restoreFocus(modalReturnFocus, hearts.find((heart) => !heart.disabled) || back);
  }

  function showConfirmation(event) {
    state = readState();
    render();
    if (!state.available) {
      onToast('当前浏览器暂时无法保存愿望状态，请稍后再试。');
      return;
    }
    if (state.used >= TOTAL || confirmationOpen || submitting) return;
    expectedUsed = state.used;
    modalReturnFocus = event.currentTarget;
    confirmationOpen = true;
    backdrop.hidden = false;
    card.inert = true;
    back.inert = true;
    cancel.focus({ preventScroll: true });
  }

  async function consume() {
    if (submitting || !confirmationOpen) return;
    submitting = true;
    render();
    let outcome = 'failed';
    const commit = () => {
      const current = readState();
      if (!current.available) return;
      if (current.used !== expectedUsed || current.used >= TOTAL) {
        outcome = 'changed';
        return;
      }
      // Wishes are understood as legal, safe, realistically achievable, and voluntary for both people.
      // Each coupon is a separate monotonic receipt; concurrent tabs cannot restore other coupons.
      const receipt = { version: 1, redeemed: true, redeemedAt: Date.now(), claim: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` };
      try {
        const key = keyFor(current.used);
        if (window.localStorage.getItem(key) !== null) {
          outcome = 'changed';
          return;
        }
        window.localStorage.setItem(key, JSON.stringify(receipt));
        const persisted = JSON.parse(window.localStorage.getItem(key) || 'null');
        outcome = persisted?.claim === receipt.claim ? 'used' : 'changed';
      } catch {
        outcome = 'failed';
      }
    };
    try {
      // Current Safari/Chrome coordinate the confirm step across tabs with a Web Lock.
      if (navigator.locks?.request) await navigator.locks.request(STORAGE_PREFIX, { mode: 'exclusive' }, commit);
      else commit();
    } catch {
      outcome = 'failed';
    }
    submitting = false;
    if (destroyed) return;
    state = readState();
    if (outcome === 'failed') state.available = false;
    render();
    closeConfirmation();
    if (outcome === 'used') onUse({ used: state.used, remaining: TOTAL - state.used });
    else if (outcome === 'changed') onToast('愿望状态已更新，请重新确认。');
    else onToast('愿望未使用：当前浏览器暂时无法保存，请稍后再试。');
  }

  function lockBackground() {
    siblingStates = [...document.body.children].filter((element) => element !== root).map((element) => ({ element, inert: element.inert }));
    siblingStates.forEach(({ element }) => { element.inert = true; });
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  function unlockBackground() {
    siblingStates.forEach(({ element, inert }) => { if (element.isConnected) element.inert = inert; });
    siblingStates = [];
    document.body.style.overflow = bodyOverflow;
  }

  function open() {
    if (!unlocked || opened || destroyed) return false;
    window.clearTimeout(closeTimer);
    opened = true;
    state = readState();
    render();
    returnFocus = document.activeElement;
    root.hidden = false;
    lockBackground();
    animationFrame = requestAnimationFrame(() => root.classList.add('is-open'));
    back.focus({ preventScroll: true });
    onOpen();
    return true;
  }

  function close() {
    if (!opened || submitting || destroyed) return false;
    opened = false;
    closeConfirmation({ restore: false });
    cancelAnimationFrame(animationFrame);
    root.classList.remove('is-open');
    unlockBackground();
    restoreFocus(returnFocus);
    closeTimer = window.setTimeout(() => { if (!opened) root.hidden = true; }, 550);
    onClose();
    return true;
  }

  function handleKey(event) {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!submitting) confirmationOpen ? closeConfirmation() : close();
      return;
    }
    if (event.key !== 'Tab') return;
    const area = confirmationOpen ? confirmation : root;
    const controls = [...area.querySelectorAll(focusableSelector)].filter((element) => !element.closest('[hidden]') && !element.closest('[inert]'));
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !area.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !area.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }

  function refresh() {
    if (destroyed) return;
    state = readState();
    render();
  }
  function handleStorage(event) {
    if (event.key === null || event.key?.startsWith(`${STORAGE_PREFIX}.`)) refresh();
  }
  function handleReset() {
    closeConfirmation();
    refresh();
  }
  function handleBackdrop(event) {
    if (event.target === backdrop && !submitting) closeConfirmation();
  }

  hearts.forEach((heart) => heart.addEventListener('click', showConfirmation));
  back.addEventListener('click', close);
  cancel.addEventListener('click', closeConfirmation);
  accept.addEventListener('click', consume);
  backdrop.addEventListener('click', handleBackdrop);
  document.addEventListener('keydown', handleKey);
  window.addEventListener('storage', handleStorage);
  window.addEventListener(RESET_EVENT, handleReset);
  render();

  return {
    unlock() { unlocked = true; },
    open,
    close,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(closeTimer);
      if (opened) unlockBackground();
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(RESET_EVENT, handleReset);
      root.remove();
    },
    get unlocked() { return unlocked; },
    get opened() { return opened; },
  };
}
