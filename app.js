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
function render(html) {
  cleanups.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
  cleanups = [];
  app.innerHTML = html;
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

const accountBar = () =>
  user
    ? `<div class="account">
        <span class="account-name">${esc(user.displayName || user.email || "")}</span>
        <button class="btn-ghost" id="sign-out">${bi("Sign out", "로그아웃")}</button>
      </div>`
    : "";
function wireAccountBar() {
  const b = $("#sign-out");
  if (b) b.addEventListener("click", () => signOut(auth));
}

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
        ${instr(
          "Sign in with Google to create a group. Your groups are saved to your account, so you can check progress and resend the link anytime.",
          "Google로 로그인하여 그룹을 만드세요. 그룹이 계정에 저장되어 언제든지 진행 상황을 확인하고 링크를 다시 보낼 수 있습니다."
        )}
        <button id="sign-in">${bi("Sign in with Google", "Google로 로그인")}</button>
        <div id="home-msg"></div>
      </section>`);
    $("#sign-in").addEventListener("click", (e) => signIn(e.currentTarget, $("#home-msg")));
    if (error) showMsg($("#home-msg"), "error", error);
    return;
  }

  render(`
    ${accountBar()}
    <section class="card stack">
      <h2>${bi("Create a new group", "새 그룹 만들기")}</h2>
      ${instr("Start a Secret Santa for your friends, family, or team.", "친구, 가족, 팀과 함께 시크릿 산타를 시작하세요.")}
      <button id="create">${bi("Create group", "그룹 만들기")}</button>
      <div id="home-msg"></div>
    </section>

    <section class="card">
      <h2>${bi("Your groups", "내 그룹")}</h2>
      <ul class="group-list" id="groups"><li class="loading"><span class="spinner"></span></li></ul>
    </section>`);
  wireAccountBar();
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
        el.innerHTML = `<li class="empty">${bi("No groups yet. Create one above!", "아직 그룹이 없어요. 위에서 만들어 보세요!")}</li>`;
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
      <h2>${bi("Create a new group", "새 그룹 만들기")}</h2>
      <div>
        <label class="field-label" for="title">${bi("Group name (optional)", "그룹 이름 (선택)")}</label>
        <input id="title" maxlength="${MAX_TITLE}" autocomplete="off" ${ph("e.g. Family Christmas 2026", "예: 2026 가족 크리스마스")}>
      </div>
      ${instr(
        `Add the name of everyone who's joining, including yourself if you're playing. You need at least ${MIN_PEOPLE} people.`,
        `본인을 포함해 참여하는 모든 사람의 이름을 추가하세요. 최소 ${MIN_PEOPLE}명이 필요합니다.`
      )}
      <form id="add" class="row" novalidate>
        <input id="name" maxlength="${MAX_NAME}" autocomplete="off" ${ph("Name", "이름")} ${al("Name", "이름")}>
        <button type="submit">${bi("Add", "추가")}</button>
      </form>
      <div id="add-msg"></div>
      <ul class="chips" id="chips"></ul>
      <p class="count" id="count"></p>
    </section>

    <section class="card stack">
      ${instr(
        "Double-check the names. They can't be changed after the group is created.",
        "이름을 다시 확인하세요. 그룹이 만들어진 후에는 변경할 수 없습니다."
      )}
      <button id="generate" disabled>${bi("Create group and draw names", "그룹 만들고 추첨하기")}</button>
      <div id="gen-msg"></div>
    </section>

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
    ${accountBar()}
    ${justCreated ? `<div class="msg ok banner" role="status">${bi("Your group is ready! Names have been drawn.", "그룹이 준비되었어요! 추첨이 완료되었습니다.")}</div>` : ""}

    <section class="card stack center">
      <h2>${esc(groupLabel(code, group))}</h2>
      ${instr(
        "Send this link to everyone in the group. If someone loses it, just send it again.",
        "이 링크를 그룹의 모든 사람에게 보내세요. 링크를 잃어버린 사람이 있으면 다시 보내면 됩니다."
      )}
      <div class="code-display">${code}</div>
      <button id="share">${bi("Share group link", "그룹 링크 공유")}</button>
      <button class="btn-secondary" id="copy">${bi("Copy group link", "그룹 링크 복사")}</button>
    </section>

    <section class="card">
      <h2>${bi("Who's joined", "참여 현황")}</h2>
      ${instr(
        "Here's who has opened the link and set their PIN. Assignments stay hidden, even from you.",
        "링크를 열고 PIN을 설정한 사람을 확인할 수 있습니다. 배정 결과는 호스트에게도 공개되지 않습니다."
      )}
      <p class="progress" id="progress"></p>
      <div class="progress-bar"><span id="bar"></span></div>
      <ul class="status-list" id="status"></ul>
    </section>

    <section class="card stack">
      ${instr(
        "Playing too? Open the group as a participant to see who you're buying for.",
        "직접 참여하시나요? 참여자로 그룹을 열어 누구에게 선물할지 확인하세요."
      )}
      <button class="btn-secondary" id="play">${bi("Open as participant", "참여자로 열기")}</button>
    </section>

    <button class="btn-ghost" id="back">${bi("← My groups", "← 내 그룹")}</button>`);
  wireAccountBar();

  function draw(joined) {
    const n = joined.size;
    $("#progress").innerHTML = bi(
      n === total ? `All ${total} people are ready!` : `${n} of ${total} people have set their PIN`,
      n === total ? `${total}명 모두 준비되었어요!` : `${total}명 중 ${n}명이 PIN을 설정했습니다`
    );
    $("#bar").style.width = `${total ? (n / total) * 100 : 0}%`;
    $("#status").innerHTML = group.names
      .map((name, i) => {
        const ok = joined.has(String(i));
        return `<li class="status ${ok ? "is-ready" : ""}">
          <span class="status-name">${esc(name)}</span>
          <span class="status-badge">${ok ? bi("✓ PIN set", "✓ PIN 설정됨") : bi("Waiting", "대기 중")}</span>
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
      ${instr(
        "Sign in with the Google account you used to create this group.",
        "이 그룹을 만들 때 사용한 Google 계정으로 로그인하세요."
      )}
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
      <h2>${bi("Select your name", "본인의 이름을 선택하세요")}</h2>
      ${instr("Tap your own name to continue.", "계속하려면 본인의 이름을 누르세요.")}
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
  const pinField = (id, label) => `
    <div>
      <label class="field-label" for="${id}">${label}</label>
      <input id="${id}" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*"
        maxlength="4" autocomplete="off" placeholder="••••">
    </div>`;

  render(`
    <section class="card">
      <h2>${bi(`Hi, ${name}!`, `안녕하세요, ${name}님!`)}</h2>
      ${
        hasPin
          ? instr("Enter your 4-digit PIN.", "4자리 PIN을 입력하세요.")
          : instr(
              "Create a 4-digit PIN. You'll need it to get back in. Don't share it, and pick one you'll remember because it can't be reset.",
              "4자리 PIN을 만드세요. 다시 들어올 때 필요합니다. 다른 사람과 공유하지 말고, 재설정할 수 없으니 기억하기 쉬운 번호로 정하세요."
            )
      }
      <form id="pin-form" class="stack" novalidate>
        ${hasPin ? pinField("pin1", bi("PIN", "PIN")) : pinField("pin1", bi("New PIN", "새 PIN")) + pinField("pin2", bi("Confirm PIN", "PIN 확인"))}
        <button type="submit" id="pin-submit">${hasPin ? bi("Continue", "계속") : bi("Set PIN and continue", "PIN 설정 후 계속")}</button>
      </form>
      <div id="pin-msg"></div>
    </section>
    <button class="btn-ghost" id="back">${bi("Not you? Go back", "본인이 아닌가요? 돌아가기")}</button>`);

  const msgEl = $("#pin-msg");
  if (notice) showMsg(msgEl, "info", notice);

  app.querySelectorAll(".pin-input").forEach((el) =>
    el.addEventListener("input", () => { el.value = el.value.replace(/\D/g, "").slice(0, 4); })
  );
  $("#pin1").focus();
  $("#back").addEventListener("click", () => renderPicker(code, group));

  $("#pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("#pin1").value;
    if (!/^\d{4}$/.test(pin)) {
      return showMsg(msgEl, "error", ["Your PIN must be exactly 4 digits.", "PIN은 숫자 4자리여야 합니다."]);
    }
    if (!hasPin && $("#pin2").value !== pin) {
      return showMsg(msgEl, "error", ["The PINs don't match.", "PIN이 일치하지 않습니다."]);
    }

    const btn = $("#pin-submit");
    btn.disabled = true;
    msgEl.innerHTML = "";
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
      btn.disabled = false;
      if (err && err.code === "permission-denied") {
        if (hasPin) {
          $("#pin1").value = "";
          $("#pin1").focus();
          return showMsg(msgEl, "error", ["Incorrect PIN. Please try again.", "PIN이 올바르지 않습니다. 다시 시도해 주세요."]);
        }
        // Someone set a PIN for this name a moment ago.
        return renderPin(code, group, i, [
          "A PIN was already set for this name. Please enter it.",
          "이 이름에는 이미 PIN이 설정되어 있습니다. PIN을 입력해 주세요.",
        ]);
      }
      console.error(err);
      showMsg(msgEl, "error", MSG.generic);
    }
  });
}

function renderDashboard(code, group, session) {
  const me = session.memberId;
  const myName = group.names[me];
  const gifteeIndex = group.giftees[me];
  const gifteeName = group.names[gifteeIndex];

  render(`
    <div class="topbar">
      <div class="hello">${bi(`Hi, ${myName}!`, `안녕하세요, ${myName}님!`)}</div>
      <button class="btn-ghost" id="switch">${bi("Not you?", "본인이 아닌가요?")}</button>
    </div>

    <section class="card santa-card">
      <p class="label">${bi("You are the Secret Santa for", "당신이 선물할 사람은")}</p>
      <div class="giftee-name">${esc(gifteeName)}</div>
      <p class="label">${bi(`${gifteeName}'s wishlist`, `${gifteeName}님의 위시리스트`)}</p>
      <div id="their-list" class="wishlist-view"><span class="empty">…</span></div>
    </section>

    <section class="card stack">
      <h2>${bi("My wishlist", "나의 위시리스트")}</h2>
      ${instr(
        "Write what you'd like to receive. Your Secret Santa will see this.",
        "받고 싶은 선물을 적어주세요. 당신의 시크릿 산타가 이 내용을 보게 됩니다."
      )}
      <textarea id="my-list" rows="7" maxlength="${MAX_WISHLIST}"
        ${ph("e.g. cozy socks, a good book, coffee beans…", "예: 포근한 양말, 좋은 책, 원두…")}
        ${al("My wishlist", "나의 위시리스트")}></textarea>
      <button id="save">${bi("Save wishlist", "위시리스트 저장")}</button>
      <div id="save-msg"></div>
    </section>
    ${hostButton(group)}`);
  wireHostButton(code);

  // Live view of the person you're buying for.
  const unsub = onSnapshot(
    memberRef(code, gifteeIndex),
    (snap) => {
      const el = $("#their-list");
      if (!el) return;
      const text = snap.exists() ? String(snap.data().wishlist || "").trim() : "";
      if (text) el.textContent = text;
      else el.innerHTML = `<span class="empty">${bi("No wishlist yet. Check back later!", "아직 위시리스트가 없어요. 나중에 다시 확인해 주세요!")}</span>`;
    },
    (err) => console.error(err)
  );
  cleanups.push(unsub);

  // Load my own wishlist.
  const textarea = $("#my-list");
  let dirty = false;
  textarea.addEventListener("input", () => { dirty = true; $("#save-msg").innerHTML = ""; });
  getDoc(memberRef(code, me))
    .then((snap) => {
      if (!dirty && snap.exists()) textarea.value = snap.data().wishlist || "";
    })
    .catch((err) => console.error(err));

  const saveBtn = $("#save");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const msgEl = $("#save-msg");
    msgEl.innerHTML = "";
    try {
      const batch = writeBatch(db);
      batch.set(proofRef(code, me), { pinHash: session.pinHash, at: serverTimestamp() });
      batch.update(memberRef(code, me), { wishlist: textarea.value.slice(0, MAX_WISHLIST), updatedAt: serverTimestamp() });
      await batch.commit();
      dirty = false;
      showMsg(msgEl, "ok", ["Saved!", "저장되었습니다!"]);
    } catch (err) {
      if (err && err.code === "permission-denied") {
        clearSession(code);
        return renderPin(code, group, me, ["Please enter your PIN again.", "PIN을 다시 입력해 주세요."]);
      }
      console.error(err);
      showMsg(msgEl, "error", MSG.generic);
    } finally {
      saveBtn.disabled = false;
    }
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
    if (first || changed) {
      route.started = true;
      route();
    }
  });
} else {
  route();
}
