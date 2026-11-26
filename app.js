import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Constants ---------- */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O (easy to confuse with 1 and 0)
const CODE_RE = /^[A-HJ-NP-Z]{6}$/;
const MIN_PEOPLE = 3;
const MAX_PEOPLE = 50;
const MAX_NAME = 40;
const MAX_TITLE = 60;
const MAX_WISHLIST = 5000;
const MAX_ITEM = 200;

/* ---------- Firebase ---------- */
const configured =
  firebaseConfig && typeof firebaseConfig.apiKey === "string" && !firebaseConfig.apiKey.startsWith("YOUR_");
const fbApp = configured ? initializeApp(firebaseConfig) : null;
const db = configured ? getFirestore(fbApp) : null;
const auth = configured ? getAuth(fbApp) : null;
let user = null; // the signed-in host, if any

const groupRef = (code) => doc(db, "groups", code);
const memberRef = (code, i) => doc(db, "groups", code, "members", String(i));
const pinRef = (code, i) => doc(db, "groups", code, "pins", String(i));
const proofRef = (code, i) => doc(db, "groups", code, "proofs", String(i));

/* ---------- Helpers ---------- */
const app = document.getElementById("app");
const $ = (sel) => app.querySelector(sel);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ---------- Language ---------- */
// Every piece of text is rendered in both languages; CSS shows only the one matching <html lang>.
// That way the toggle switches instantly without re-rendering or losing what people typed.
const LANG_KEY = "secret-santa:lang";
let lang = (() => {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "ko") return saved;
  } catch { /* ignore */ }
  return (navigator.language || "").toLowerCase().startsWith("ko") ? "ko" : "en";
})();

const L = (en, ko) => (lang === "ko" ? ko : en); // plain string for the current language
const bi = (en, ko) => `<span class="en">${esc(en)}</span><span class="ko">${esc(ko)}</span>`;
const instr = (en, ko) => `<p class="instr">${bi(en, ko)}</p>`;
// Attributes that also need translating (placeholder, aria-label).
const ph = (en, ko) => `placeholder="${esc(L(en, ko))}" data-ph-en="${esc(en)}" data-ph-ko="${esc(ko)}"`;
const al = (en, ko) => `aria-label="${esc(L(en, ko))}" data-al-en="${esc(en)}" data-al-ko="${esc(ko)}"`;

function applyLang() {
  document.documentElement.lang = lang;
  document.title = L("Secret Santa", "시크릿 산타");
  const k = lang === "ko" ? "Ko" : "En";
  document.querySelectorAll("[data-ph-en]").forEach((el) => { el.placeholder = el.dataset[`ph${k}`]; });
  document.querySelectorAll("[data-al-en]").forEach((el) => el.setAttribute("aria-label", el.dataset[`al${k}`]));
}

const langBtn = document.getElementById("lang");
langBtn.addEventListener("click", () => {
  lang = lang === "ko" ? "en" : "ko";
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  applyLang();
});
applyLang();

/* ---------- Messages & rendering ---------- */
const MSG = {
  generic: ["Something went wrong. Please try again.", "문제가 발생했습니다. 다시 시도해 주세요."],
  notFound: ["We couldn't find that group. Ask your host to send the link again.", "그룹을 찾을 수 없습니다. 호스트에게 링크를 다시 보내달라고 요청하세요."],
  badLink: ["That link doesn't look right. Ask your host to send it again.", "링크가 올바르지 않습니다. 호스트에게 다시 보내달라고 요청하세요."],
  signInFailed: ["Sign-in didn't finish. Please try again.", "로그인이 완료되지 않았습니다. 다시 시도해 주세요."],
};

function showMsg(el, type, [en, ko]) {
  if (el) el.innerHTML = `<div class="msg ${type}" role="${type === "error" ? "alert" : "status"}">${bi(en, ko)}</div>`;
}

let cleanups = [];
// Participant screens sit vertically centered when they fit on screen (and start at the
// top when they don't). Host screens ({ top: true }) always start at the top.
function render(html, { top = false } = {}) {
  cleanups.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
  cleanups = [];
  app.classList.toggle("is-centered", !top);
  app.innerHTML = `<div class="view">${html}</div>`;
  window.scrollTo(0, 0);
}
const renderLoading = () =>
  render(`<div class="loading"><span class="spinner" ${al("Loading", "불러오는 중")}></span></div>`);

function randInt(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}

function makeCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
  return s;
}

// Shuffle everyone into one loop; each person gives to the next one.
// This guarantees nobody draws themselves.
function makeAssignments(n) {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const giftees = new Array(n);
  for (let k = 0; k < n; k++) giftees[order[k]] = order[(k + 1) % n];
  return giftees;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hashPin = (code, memberId, pin) => sha256(`secret-santa:${code}:${memberId}:${pin}`);

// A wishlist is stored as one string with one gift per line.
function splitItems(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Stable 16-hex id for a gift (case and spacing ignored), used for "I'll get it" marks.
function itemKey(text) {
  const t = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const isOwner = (group) => !!(user && group && group.ownerUid === user.uid);
const groupLabel = (code, group) => (group && group.title ? group.title : code);

/* ---------- Remember who you are on this device ---------- */
const sessionKey = (code) => `secret-santa:${code}`;
function loadSession(code) {
  try { return JSON.parse(localStorage.getItem(sessionKey(code))); } catch { return null; }
}
function saveSession(code, s) {
  try { localStorage.setItem(sessionKey(code), JSON.stringify(s)); } catch { /* private mode */ }
}
function clearSession(code) {
  try { localStorage.removeItem(sessionKey(code)); } catch { /* ignore */ }
}

/* ---------- Links & routing ---------- */
// Participant link: ?g=CODE. Host dashboard: ?g=CODE&view=host (needs the host's Google sign-in).
function groupUrl(code) {
  const u = new URL(location.href);
  u.search = `?g=${code}`;
  u.hash = "";
  return u.toString();
}

function go(code, view) {
  const search = code ? `?g=${code}${view ? `&view=${view}` : ""}` : location.pathname;
  history.pushState(null, "", search);
  route();
}

async function copyLink(code, btn) {
  const url = groupUrl(code);
  try {
    await navigator.clipboard.writeText(url);
    const original = btn.innerHTML;
    btn.innerHTML = bi("Link copied!", "링크가 복사되었습니다!");
    setTimeout(() => { btn.innerHTML = original; }, 1800);
  } catch {
    window.prompt(L("Copy this link", "이 링크를 복사하세요"), url);
  }
}

async function shareLink(code, group, btn) {
  const url = groupUrl(code);
  if (navigator.share) {
    try {
      await navigator.share({
        title: L("Secret Santa", "시크릿 산타"),
        text: L(
          `You're in the Secret Santa "${groupLabel(code, group)}"! Open this link, pick your name, and see who you're buying for.`,
          `시크릿 산타 "${groupLabel(code, group)}"에 초대되었어요! 링크를 열고 이름을 선택하면 누구에게 선물할지 확인할 수 있어요.`
        ),
        url,
      });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // they closed the share sheet
    }
  }
  copyLink(code, btn);
}

async function route() {
  if (!configured) return renderSetup();
  const params = new URLSearchParams(location.search);
  const code = (params.get("g") || "").trim().toUpperCase();
  if (!code) return renderHome();
  if (!CODE_RE.test(code)) {
    history.replaceState(null, "", location.pathname);
    return renderHome(MSG.badLink);
  }
  return openGroup(code, { hostView: params.get("view") === "host" });
}

window.addEventListener("popstate", route);
const brand = document.getElementById("brand");
brand.addEventListener("click", () => go(null));
brand.addEventListener("keydown", (e) => { if (e.key === "Enter") go(null); });

/* ---------- Account ---------- */
async function signIn(btn, msgEl) {
  if (btn) btn.disabled = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    // onAuthStateChanged re-renders the page.
  } catch (err) {
    if (btn) btn.disabled = false;
    if (err && (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request")) return;
    console.error(err);
    showMsg(msgEl, "error", MSG.signInFailed);
  }
}

// Person icon in the header: a small menu to sign in, or go to "My groups" / sign out.
const accountBtn = document.getElementById("account");
const accountMenu = document.getElementById("account-menu");

function setMenuOpen(open) {
  accountMenu.hidden = !open;
  accountBtn.setAttribute("aria-expanded", String(open));
}

function drawAccountMenu() {
  accountMenu.innerHTML = user
    ? `<div class="menu-who">${esc(user.displayName || user.email || "")}</div>
       <button type="button" class="menu-item" role="menuitem" data-act="groups">${bi("My groups", "내 그룹")}</button>
       <button type="button" class="menu-item" role="menuitem" data-act="out">${bi("Sign out", "로그아웃")}</button>`
    : `<button type="button" class="menu-item" role="menuitem" data-act="in">${bi("Sign in with Google", "Google로 로그인")}</button>`;
}

accountBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen(accountMenu.hidden);
});
accountMenu.addEventListener("click", (e) => {
  const item = e.target.closest("[data-act]");
  if (!item) return;
  setMenuOpen(false);
  if (item.dataset.act === "groups") go(null);
  else if (item.dataset.act === "out") signOut(auth).then(() => go(null));
  else if (item.dataset.act === "in") signIn();
});
document.addEventListener("click", (e) => {
  if (!accountMenu.hidden && !e.target.closest(".account-wrap")) setMenuOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !accountMenu.hidden) { setMenuOpen(false); accountBtn.focus(); }
});
drawAccountMenu();

/* ---------- Views ---------- */
function renderSetup() {
  render(`
    <section class="card">
      <h2>${bi("Almost ready", "거의 다 됐어요")}</h2>
      ${instr(
        "The site owner still needs to add the Firebase settings to firebase-config.js. See README.md for the steps.",
        "사이트 관리자가 firebase-config.js에 Firebase 설정을 추가해야 합니다. 방법은 README.md를 참고하세요."
      )}
    </section>`);
}

function renderHome(error) {
  if (!user) {
    render(`
      <section class="card stack">
        <h2>${bi("Create a Secret Santa", "시크릿 산타 만들기")}</h2>
        <button id="sign-in">${bi("Sign in with Google", "Google로 로그인")}</button>
        <div id="home-msg"></div>
      </section>`);
    $("#sign-in").addEventListener("click", (e) => signIn(e.currentTarget, $("#home-msg")));
    if (error) showMsg($("#home-msg"), "error", error);
    return;
  }

  render(`
    <section class="card stack">
      <button id="create">${bi("+ New group", "+ 새 그룹")}</button>
      <div id="home-msg"></div>
    </section>

    <section class="card">
      <h2>${bi("Your groups", "내 그룹")}</h2>
      <ul class="group-list" id="groups"><li class="loading"><span class="spinner"></span></li></ul>
    </section>`, { top: true });
  $("#create").addEventListener("click", renderCreate);
  if (error) showMsg($("#home-msg"), "error", error);

  const uid = user.uid;
  getDocs(query(collection(db, "groups"), where("ownerUid", "==", uid)))
    .then((snap) => {
      const el = $("#groups");
      if (!el || !user || user.uid !== uid) return;
      const groups = snap.docs
        .map((d) => ({ code: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      if (!groups.length) {
        el.innerHTML = `<li class="empty">${bi("No groups yet.", "아직 그룹이 없어요.")}</li>`;
        return;
      }
      el.innerHTML = groups
        .map((g) => {
          const date = g.createdAt?.toDate?.();
          const when = date ? date.toLocaleDateString(lang === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
          const n = Array.isArray(g.names) ? g.names.length : 0;
          return `<li><button class="group-item btn-secondary" data-code="${esc(g.code)}">
            <span class="group-title">${esc(g.title || g.code)}</span>
            <span class="group-meta">${bi(`${n} people`, `${n}명`)} · ${esc(g.code)}${when ? ` · ${esc(when)}` : ""}</span>
          </button></li>`;
        })
        .join("");
      el.querySelectorAll("[data-code]").forEach((b) => b.addEventListener("click", () => go(b.dataset.code, "host")));
    })
    .catch((err) => {
      console.error(err);
      const el = $("#groups");
      if (el) el.innerHTML = `<li>${bi(MSG.generic[0], MSG.generic[1])}</li>`;
    });
}

function renderCreate() {
  if (!user) return renderHome();
  const names = [];

  render(`
    <section class="card stack">
      <h2>${bi("New group", "새 그룹")}</h2>
      <div>
        <label class="field-label" for="title">${bi("Group name (optional)", "그룹 이름 (선택)")}</label>
        <input id="title" maxlength="${MAX_TITLE}" autocomplete="off" ${ph("e.g. Family Christmas 2026", "예: 2026 가족 크리스마스")}>
      </div>
      ${instr(`Add everyone's names (at least ${MIN_PEOPLE}).`, `참여자 이름을 모두 추가하세요 (최소 ${MIN_PEOPLE}명).`)}
      <form id="add" class="row" novalidate>
        <input id="name" maxlength="${MAX_NAME}" autocomplete="off" ${ph("Name", "이름")} ${al("Name", "이름")}>
        <button type="submit">${bi("Add", "추가")}</button>
      </form>
      <div id="add-msg"></div>
      <ul class="chips" id="chips"></ul>
      <p class="count" id="count"></p>
    </section>

    <div class="actions">
      <button id="generate" disabled>${bi("Create group and draw names", "그룹 만들고 추첨하기")}</button>
      <div id="gen-msg"></div>
    </div>

    <button class="btn-ghost" id="back">${bi("← Back", "← 뒤로")}</button>`);

  const input = $("#name");
  const genBtn = $("#generate");

  function draw() {
    $("#chips").innerHTML = names
      .map(
        (n, i) => `<li class="chip">${esc(n)}
          <button type="button" data-remove="${i}" ${al(`Remove ${n}`, `${n} 삭제`)}>×</button></li>`
      )
      .join("");
    $("#count").innerHTML = names.length
      ? bi(`${names.length} ${names.length === 1 ? "person" : "people"}`, `${names.length}명`)
      : "";
    genBtn.disabled = names.length < MIN_PEOPLE;
  }

  $("#chips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    names.splice(Number(btn.dataset.remove), 1);
    $("#add-msg").innerHTML = "";
    draw();
  });

  $("#add").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    const msgEl = $("#add-msg");
    msgEl.innerHTML = "";
    if (!name) return;
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return showMsg(msgEl, "error", ["That name is already on the list.", "이미 추가된 이름입니다."]);
    }
    if (names.length >= MAX_PEOPLE) {
      return showMsg(msgEl, "error", [`A group can have up to ${MAX_PEOPLE} people.`, `그룹은 최대 ${MAX_PEOPLE}명까지 가능합니다.`]);
    }
    names.push(name);
    input.value = "";
    input.focus();
    draw();
  });

  genBtn.addEventListener("click", async () => {
    if (names.length < MIN_PEOPLE || !user) return;
    const original = genBtn.innerHTML;
    genBtn.disabled = true;
    genBtn.innerHTML = bi("Creating…", "생성 중…");
    try {
      let code = null;
      for (let tries = 0; tries < 8 && !code; tries++) {
        const candidate = makeCode();
        if (!(await getDoc(groupRef(candidate))).exists()) code = candidate;
      }
      if (!code) throw new Error("Could not find a free code");
      const title = $("#title").value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
      const data = {
        names: [...names],
        giftees: makeAssignments(names.length),
        ownerUid: user.uid,
        createdAt: serverTimestamp(),
      };
      if (title) data.title = title;
      await setDoc(groupRef(code), data);
      history.pushState(null, "", `?g=${code}&view=host`);
      openGroup(code, { hostView: true, justCreated: true });
    } catch (err) {
      console.error(err);
      showMsg($("#gen-msg"), "error", MSG.generic);
      genBtn.innerHTML = original;
      genBtn.disabled = false;
    }
  });

  $("#back").addEventListener("click", () => renderHome());
  input.focus();
}

function renderHostView(code, group, { justCreated = false } = {}) {
  const total = group.names.length;

  render(`
    ${justCreated ? `<div class="msg ok banner" role="status">${bi("Done! Names are drawn.", "완료! 추첨이 끝났어요.")}</div>` : ""}

    <section class="card stack center">
      <h2>${esc(groupLabel(code, group))}</h2>
      ${instr("Send this link to everyone.", "이 링크를 모두에게 보내세요.")}
      <div class="code-display">${code}</div>
      <button id="share">${bi("Share group link", "그룹 링크 공유")}</button>
      <button class="btn-secondary" id="copy">${bi("Copy group link", "그룹 링크 복사")}</button>
    </section>

    <section class="card">
      <h2>${bi("Who's joined", "참여 현황")}</h2>
      <p class="progress" id="progress"></p>
      <div class="progress-bar"><span id="bar"></span></div>
      <ul class="status-list" id="status"></ul>
    </section>

    <section class="card" id="reveal-card" hidden>
      <h2>${bi("Who's buying for whom", "누가 누구에게")}</h2>
      <ul class="status-list">
        ${group.names
          .map((name, i) => `<li class="status">
            <span class="status-name">${esc(name)}</span>
            <span class="pair-arrow" aria-hidden="true">→</span>
            <span class="status-name pair-to">${esc(group.names[group.giftees[i]] ?? "?")}</span>
          </li>`)
          .join("")}
      </ul>
    </section>

    <div class="actions">
      <div class="btn-row">
        <button class="btn-secondary" id="play">${bi("Open as participant", "참여자로 열기")}</button>
        <button class="btn-secondary" id="reveal">${bi("Reveal all", "전체 공개")}</button>
      </div>
      <button class="btn-danger" id="delete">${bi("Delete group", "그룹 삭제")}</button>
      <div id="host-msg"></div>
    </div>

    <button class="btn-ghost" id="back">${bi("← My groups", "← 내 그룹")}</button>`, { top: true });

  function draw(joined) {
    const n = joined.size;
    $("#progress").innerHTML = bi(
      n === total ? `All ${total} joined!` : `${n} of ${total} joined`,
      n === total ? `${total}명 모두 참여했어요!` : `${total}명 중 ${n}명 참여`
    );
    $("#bar").style.width = `${total ? (n / total) * 100 : 0}%`;
    $("#status").innerHTML = group.names
      .map((name, i) => {
        const ok = joined.has(String(i));
        return `<li class="status ${ok ? "is-ready" : ""}">
          <span class="status-name">${esc(name)}</span>
          <span class="status-badge">${ok ? bi("✓ Joined", "✓ 참여") : bi("Waiting", "대기 중")}</span>
        </li>`;
      })
      .join("");
  }

  draw(new Set());
  const unsub = onSnapshot(
    collection(db, "groups", code, "members"),
    (snap) => draw(new Set(snap.docs.map((d) => d.id))),
    (err) => console.error(err)
  );
  cleanups.push(unsub);

  $("#share").addEventListener("click", (e) => shareLink(code, group, e.currentTarget));
  $("#copy").addEventListener("click", (e) => copyLink(code, e.currentTarget));
  $("#play").addEventListener("click", () => go(code));
  $("#back").addEventListener("click", () => go(null));

  const revealBtn = $("#reveal");
  revealBtn.addEventListener("click", () => {
    const card = $("#reveal-card");
    if (card.hidden) {
      const ok = window.confirm(L(
        "Show who is buying for whom? If you're playing too, this spoils your surprise.",
        "누가 누구에게 선물하는지 볼까요? 직접 참여 중이라면 깜짝 선물이 미리 공개돼요."
      ));
      if (!ok) return;
      card.hidden = false;
      revealBtn.innerHTML = bi("Hide", "숨기기");
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      card.hidden = true;
      revealBtn.innerHTML = bi("Reveal all", "전체 공개");
    }
  });

  const deleteBtn = $("#delete");
  deleteBtn.addEventListener("click", async () => {
    const ok = window.confirm(L(
      `Delete "${groupLabel(code, group)}"? Everyone's PINs and wishlists will be erased. This can't be undone.`,
      `"${groupLabel(code, group)}" 그룹을 삭제할까요? 모든 비밀번호와 위시리스트가 지워지며 되돌릴 수 없어요.`
    ));
    if (!ok) return;
    deleteBtn.disabled = true;
    deleteBtn.innerHTML = bi("Deleting…", "삭제 중…");
    try {
      // Marks, then members/PINs/proofs (the rules check ownership via the group doc), then the group.
      const markDocs = (await getDocs(collection(db, "groups", code, "marks"))).docs;
      for (let k = 0; k < markDocs.length; k += 400) {
        const mb = writeBatch(db);
        markDocs.slice(k, k + 400).forEach((d) => mb.delete(d.ref));
        await mb.commit();
      }
      const batch = writeBatch(db);
      group.names.forEach((_, i) => {
        batch.delete(memberRef(code, i));
        batch.delete(pinRef(code, i));
        batch.delete(proofRef(code, i));
      });
      await batch.commit();
      await deleteDoc(groupRef(code));
      go(null);
    } catch (err) {
      console.error(err);
      deleteBtn.disabled = false;
      deleteBtn.innerHTML = bi("Delete group", "그룹 삭제");
      showMsg($("#host-msg"), "error", MSG.generic);
    }
  });
}

// "Host view" button on participant pages, shown only to the signed-in host.
const hostButton = (group) =>
  isOwner(group) ? `<button class="btn-secondary" id="host-view">${bi("Host view", "호스트 화면")}</button>` : "";
function wireHostButton(code) {
  const b = $("#host-view");
  if (b) b.addEventListener("click", () => go(code, "host"));
}

async function openGroup(code, { hostView = false, justCreated = false } = {}) {
  renderLoading();
  let group;
  try {
    const snap = await getDoc(groupRef(code));
    if (!snap.exists()) {
      history.replaceState(null, "", location.pathname);
      return renderHome(MSG.notFound);
    }
    group = snap.data();
    if (!Array.isArray(group.names) || !Array.isArray(group.giftees)) throw new Error("Bad group data");
  } catch (err) {
    console.error(err);
    history.replaceState(null, "", location.pathname);
    return renderHome(MSG.generic);
  }

  if (hostView) {
    if (isOwner(group)) return renderHostView(code, group, { justCreated });
    if (!user) return renderHostSignIn(code);
    history.replaceState(null, "", `?g=${code}`); // signed in, but not this group's host
  }

  const session = loadSession(code);
  if (session && session.pinHash && group.names[session.memberId] !== undefined) {
    return renderDashboard(code, group, session);
  }
  return renderPicker(code, group);
}

function renderHostSignIn(code) {
  render(`
    <section class="card stack">
      <h2>${bi("Host sign-in", "호스트 로그인")}</h2>
      <button id="sign-in">${bi("Sign in with Google", "Google로 로그인")}</button>
      <div id="msg"></div>
    </section>
    <button class="btn-ghost" id="play">${bi("I'm a participant", "참여자입니다")}</button>`);
  $("#sign-in").addEventListener("click", (e) => signIn(e.currentTarget, $("#msg")));
  $("#play").addEventListener("click", () => go(code));
}

function renderPicker(code, group) {
  render(`
    <section class="card">
      ${group.title ? `<p class="label">${esc(group.title)}</p>` : ""}
      <h2>${bi("Who are you?", "누구세요?")}</h2>
      ${instr("Tap your name.", "이름을 눌러주세요.")}
      <div class="name-grid">
        ${group.names.map((n, i) => `<button class="btn-secondary" data-i="${i}">${esc(n)}</button>`).join("")}
      </div>
    </section>
    ${hostButton(group)}`);

  app.querySelectorAll("[data-i]").forEach((b) =>
    b.addEventListener("click", () => renderPin(code, group, Number(b.dataset.i)))
  );
  wireHostButton(code);
}

// Full-screen number pad. New PIN: enter twice. Existing PIN: checked as soon as 4 digits are in.
async function renderPin(code, group, i, notice) {
  renderLoading();
  let hasPin;
  try {
    hasPin = (await getDoc(memberRef(code, i))).exists();
  } catch (err) {
    console.error(err);
    renderPicker(code, group);
    return;
  }

  const name = group.names[i];
  const TITLES = {
    enter: ["Enter your PIN", "비밀번호를 입력하세요"],
    create: ["Create your PIN", "비밀번호를 만드세요"],
    confirm: ["Confirm your PIN", "비밀번호를 한 번 더 입력하세요"],
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];

  render(`
    <section class="card pin-screen">
      <p class="pin-name">${esc(name)}</p>
      <h2 id="pin-title"></h2>
      <div class="pin-dots" id="dots" aria-hidden="true">${"<span></span>".repeat(4)}</div>
      <div class="pin-msg" id="pin-msg" role="status"></div>
      <div class="keypad">
        ${keys
          .map((k) =>
            k === ""
              ? `<span></span>`
              : k === "del"
                ? `<button type="button" class="key key-del" data-key="del" ${al("Delete", "지우기")}>
                    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
                  </button>`
                : `<button type="button" class="key" data-key="${k}">${k}</button>`
          )
          .join("")}
      </div>
      <button class="btn-ghost" id="back">${bi("Not you?", "본인이 아닌가요?")}</button>
    </section>`);

  let step = hasPin ? "enter" : "create";
  let digits = "";
  let firstPin = "";
  let busy = false;
  const dots = $("#dots");
  const msgEl = $("#pin-msg");

  const say = (pair) => { msgEl.innerHTML = pair ? bi(pair[0], pair[1]) : ""; };
  function setStep(s) {
    step = s;
    $("#pin-title").innerHTML = bi(...TITLES[s]);
  }
  function drawDots() {
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k < digits.length));
  }
  function shake() {
    dots.classList.remove("shake");
    void dots.offsetWidth; // restart the animation
    dots.classList.add("shake");
    if (navigator.vibrate) navigator.vibrate(120);
  }

  setStep(step);
  drawDots();
  if (notice) say(notice);
  else if (!hasPin) say(["Remember it for next time.", "다음에도 필요하니 꼭 기억하세요."]);

  async function submit(pin) {
    busy = true;
    const pinHash = await hashPin(code, i, pin);
    const batch = writeBatch(db);
    if (hasPin) {
      batch.set(proofRef(code, i), { pinHash, at: serverTimestamp() });
      batch.update(memberRef(code, i), { updatedAt: serverTimestamp() });
    } else {
      batch.set(pinRef(code, i), { pinHash });
      batch.set(memberRef(code, i), { wishlist: "", updatedAt: serverTimestamp() });
    }
    try {
      await batch.commit();
      const session = { memberId: i, pinHash };
      saveSession(code, session);
      renderDashboard(code, group, session);
    } catch (err) {
      busy = false;
      digits = "";
      drawDots();
      if (err && err.code === "permission-denied") {
        if (hasPin) {
          shake();
          return say(["Wrong PIN. Try again.", "비밀번호가 틀렸어요. 다시 해주세요."]);
        }
        // Someone set a PIN for this name a moment ago.
        return renderPin(code, group, i, ["This name already has a PIN.", "이미 비밀번호가 있는 이름이에요."]);
      }
      console.error(err);
      say(MSG.generic);
    }
  }

  function press(k) {
    if (busy) return;
    if (k === "del") {
      digits = digits.slice(0, -1);
      return drawDots();
    }
    if (digits.length >= 4) return;
    digits += k;
    drawDots();
    if (digits.length < 4) {
      if (digits.length === 1 && step !== "confirm") say(null);
      return;
    }
    // Four digits entered: let the last dot fill in, then move on.
    const pin = digits;
    busy = true;
    setTimeout(() => {
      busy = false;
      if (step === "create") {
        firstPin = pin;
        digits = "";
        drawDots();
        setStep("confirm");
        say(null);
      } else if (step === "confirm") {
        if (pin === firstPin) return submit(pin);
        digits = "";
        firstPin = "";
        drawDots();
        shake();
        setStep("create");
        say(["Didn't match. Start again.", "일치하지 않아요. 처음부터 다시 해주세요."]);
      } else {
        submit(pin);
      }
    }, 180);
  }

  app.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => press(b.dataset.key)));
  const onKey = (e) => {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("del");
  };
  document.addEventListener("keydown", onKey);
  cleanups.push(() => document.removeEventListener("keydown", onKey));
  $("#back").addEventListener("click", () => renderPicker(code, group));
}

function renderDashboard(code, group, session) {
  const me = session.memberId;
  const myName = group.names[me];
  const gifteeIndex = group.giftees[me];
  const gifteeName = group.names[gifteeIndex];
  const others = group.names.map((_, i) => i).filter((i) => i !== me && i !== gifteeIndex);

  render(`
    <div class="topbar">
      <div class="hello">${bi(`Hi, ${myName}!`, `안녕하세요, ${myName}님!`)}</div>
      <button class="btn-ghost" id="switch">${bi("Not you?", "본인이 아닌가요?")}</button>
    </div>

    <section class="card santa-card">
      <p class="label">${bi("Your gift is for", "선물할 사람")}</p>
      <div class="giftee-name">${esc(gifteeName)}</div>
      <p class="label">${bi(`${gifteeName} wants`, `${gifteeName}님이 원하는 것`)}</p>
      <ul class="gift-list" id="list-${gifteeIndex}"></ul>
    </section>

    <section class="card stack">
      <h2>${bi("What do you want?", "받고 싶은 선물")}</h2>
      <form id="add-item" class="row" novalidate>
        <input id="item" maxlength="${MAX_ITEM}" autocomplete="off" ${ph("e.g. warm socks", "예: 따뜻한 양말")} ${al("Gift", "선물")}>
        <button type="submit" id="add-btn" disabled>${bi("Add", "추가")}</button>
      </form>
      <ul class="my-items" id="my-items"></ul>
      <div class="save-status" id="save-msg" role="status"></div>
    </section>

    ${others.length ? `
    <section class="card">
      <h2>${bi("Everyone else", "다른 사람들")}</h2>
      ${instr("Tap “I'll get it” so no one buys the same gift.", "같은 선물을 사지 않도록 ‘제가 살게요’를 눌러주세요.")}
      <div class="people">
        ${others.map((i) => `
          <div class="person">
            <button type="button" class="person-head" data-person="${i}" aria-expanded="false">
              <span class="person-name">${esc(group.names[i])}</span>
              <span class="person-count" id="count-${i}"></span>
              <svg class="chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
            </button>
            <ul class="gift-list" id="list-${i}" hidden></ul>
          </div>`).join("")}
      </div>
    </section>` : ""}
    ${hostButton(group)}`);
  wireHostButton(code);

  /* ----- Live data: everyone's lists, and "I'll get it" marks ----- */
  const lists = new Map();   // member index -> [item text]
  const marks = new Map();   // "owner_key" -> by (member index)
  const busy = new Set();    // marks being written, to ignore double taps
  let myItems = null;        // my own list; null until loaded

  function markState(id) {
    if (!marks.has(id)) return "free";
    return marks.get(id) === me ? "mine" : "taken";
  }

  function giftRows(owner) {
    const items = lists.get(owner) || [];
    if (!items.length) return `<li class="gift-empty">${bi("Nothing yet.", "아직 없어요.")}</li>`;
    const seen = new Set();
    return items
      .map((item) => {
        const id = `${owner}_${itemKey(item)}`;
        if (seen.has(id)) return "";
        seen.add(id);
        const state = markState(id);
        const label =
          state === "mine" ? bi("✓ You're getting this", "✓ 내가 사요")
          : state === "taken" ? bi("Taken", "다른 사람이 사요")
          : bi("I'll get it", "제가 살게요");
        return `<li class="gift is-${state}">
          <span class="gift-text">${esc(item)}</span>
          <button type="button" class="gift-btn" data-mark="${id}" data-owner="${owner}" ${state === "taken" ? "disabled" : ""}>${label}</button>
        </li>`;
      })
      .join("");
  }

  function drawLists() {
    for (const owner of [gifteeIndex, ...others]) {
      const el = $(`#list-${owner}`);
      if (el) el.innerHTML = giftRows(owner);
      const count = $(`#count-${owner}`);
      if (count) {
        const n = (lists.get(owner) || []).length;
        count.textContent = n ? String(n) : "";
      }
    }
  }

  function drawMine() {
    const el = $("#my-items");
    if (!el || !myItems) return;
    el.innerHTML = myItems.length
      ? myItems
          .map((item, k) => `<li class="my-item"><span class="gift-text">${esc(item)}</span>
            <button type="button" class="remove" data-remove="${k}" ${al(`Remove ${item}`, `${item} 삭제`)}>×</button></li>`)
          .join("")
      : "";
  }

  drawLists();
  cleanups.push(onSnapshot(
    collection(db, "groups", code, "members"),
    (snap) => {
      lists.clear();
      snap.docs.forEach((d) => lists.set(Number(d.id), splitItems(d.data().wishlist)));
      if (myItems === null) {
        myItems = [...(lists.get(me) || [])];
        $("#add-btn").disabled = false;
        drawMine();
      }
      drawLists();
    },
    (err) => console.error(err)
  ));
  cleanups.push(onSnapshot(
    collection(db, "groups", code, "marks"),
    (snap) => {
      marks.clear();
      // Never keep marks on my own list: the owner must not know what's been bought.
      snap.docs.forEach((d) => { const m = d.data(); if (m.owner !== me) marks.set(d.id, m.by); });
      drawLists();
    },
    (err) => console.error(err)
  ));

  /* ----- Expand / collapse a person (one open at a time) ----- */
  app.querySelectorAll("[data-person]").forEach((head) =>
    head.addEventListener("click", () => {
      const willOpen = head.getAttribute("aria-expanded") !== "true";
      app.querySelectorAll("[data-person]").forEach((h) => {
        h.setAttribute("aria-expanded", "false");
        $(`#list-${h.dataset.person}`).hidden = true;
      });
      if (willOpen) {
        head.setAttribute("aria-expanded", "true");
        $(`#list-${head.dataset.person}`).hidden = false;
      }
    })
  );

  /* ----- "I'll get it" / undo ----- */
  app.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-mark]");
    if (!btn || btn.disabled) return;
    const id = btn.dataset.mark;
    const owner = Number(btn.dataset.owner);
    const state = markState(id);
    if (state === "taken" || busy.has(id)) return;
    busy.add(id);
    try {
      const batch = writeBatch(db);
      batch.set(proofRef(code, me), { pinHash: session.pinHash, at: serverTimestamp() });
      const ref = doc(db, "groups", code, "marks", id);
      if (state === "free") batch.set(ref, { owner, by: me, at: serverTimestamp() });
      else batch.delete(ref);
      // The marks listener shows the change right away and undoes it if the write is rejected
      // (e.g. someone else claimed the item a moment earlier).
      await batch.commit();
    } catch (err) {
      if (!(err && err.code === "permission-denied")) console.error(err);
    } finally {
      busy.delete(id);
    }
  });

  /* ----- My own list: add / remove, saved right away ----- */
  const statusEl = $("#save-msg");
  let saved = null;
  let saving = false;
  let again = false;
  let retry = null;
  // Amber spinner + "Saving" as soon as the list changes, green "✓ Saved" once Firestore confirms.
  function status(state) {
    if (!statusEl) return;
    statusEl.className = `save-status ${state || ""}`;
    statusEl.innerHTML =
      state === "saving" ? `<span class="mini-spinner" aria-hidden="true"></span>${bi("Saving", "저장 중")}`
      : state === "saved" ? `<span aria-hidden="true">✓</span>${bi("Saved", "저장됨")}`
      : state === "error" ? bi("Couldn't save. Will retry.", "저장하지 못했어요. 다시 시도할게요.")
      : "";
  }

  async function save() {
    clearTimeout(retry);
    if (!myItems) return;
    if (saving) { again = true; return; }
    const text = myItems.join("\n").slice(0, MAX_WISHLIST);
    if (text === saved) return status("saved");
    saving = true;
    status("saving");
    try {
      const batch = writeBatch(db);
      batch.set(proofRef(code, me), { pinHash: session.pinHash, at: serverTimestamp() });
      batch.update(memberRef(code, me), { wishlist: text, updatedAt: serverTimestamp() });
      await batch.commit();
      saved = text;
      if (myItems.join("\n").slice(0, MAX_WISHLIST) === saved) status("saved");
    } catch (err) {
      if (err && err.code === "permission-denied") {
        clearSession(code);
        return renderPin(code, group, me, ["Please enter your PIN again.", "비밀번호를 다시 입력하세요."]);
      }
      console.error(err);
      status("error");
      retry = setTimeout(save, 4000);
    } finally {
      saving = false;
      if (again) { again = false; save(); }
    }
  }

  const input = $("#item");
  $("#add-item").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!myItems) return;
    const item = input.value.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM);
    if (!item) return;
    input.value = "";
    input.focus();
    if (myItems.some((x) => itemKey(x) === itemKey(item))) return;
    if ([...myItems, item].join("\n").length > MAX_WISHLIST) return;
    if (saved === null) saved = myItems.join("\n");
    myItems.push(item);
    drawMine();
    status("saving");
    save();
  });
  $("#my-items").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b || !myItems) return;
    if (saved === null) saved = myItems.join("\n");
    myItems.splice(Number(b.dataset.remove), 1);
    drawMine();
    status("saving");
    save();
  });

  $("#switch").addEventListener("click", () => {
    clearSession(code);
    renderPicker(code, group);
  });
}

/* ---------- Start ---------- */
// Wait for Firebase to restore any saved sign-in before the first render,
// then re-render whenever the host signs in or out.
if (configured) {
  onAuthStateChanged(auth, (u) => {
    const changed = (u && u.uid) !== (user && user.uid);
    const first = !route.started;
    user = u;
    drawAccountMenu();
    if (first || changed) {
      route.started = true;
      route();
    }
  });
} else {
  route();
}
