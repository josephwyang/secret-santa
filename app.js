import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  collection,
  getDoc,
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
const MAX_WISHLIST = 5000;

/* ---------- Firebase ---------- */
const configured =
  firebaseConfig && typeof firebaseConfig.apiKey === "string" && !firebaseConfig.apiKey.startsWith("YOUR_");
const db = configured ? getFirestore(initializeApp(firebaseConfig)) : null;

const groupRef = (code) => doc(db, "groups", code);
const memberRef = (code, i) => doc(db, "groups", code, "members", String(i));
const pinRef = (code, i) => doc(db, "groups", code, "pins", String(i));
const proofRef = (code, i) => doc(db, "groups", code, "proofs", String(i));

/* ---------- Helpers ---------- */
const app = document.getElementById("app");
const $ = (sel) => app.querySelector(sel);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// English text with its Korean translation underneath.
const bi = (en, ko) => `${esc(en)}<span class="ko">${esc(ko)}</span>`;
const instr = (en, ko) => `<p class="instr">${bi(en, ko)}</p>`;

const MSG = {
  generic: ["Something went wrong. Please try again.", "문제가 발생했습니다. 다시 시도해 주세요."],
  notFound: ["We couldn't find a group with that code.", "해당 코드의 그룹을 찾을 수 없습니다."],
  badCode: ["Codes are 6 letters, like ABCDEF.", "코드는 ABCDEF처럼 6자리 영문입니다."],
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
const renderLoading = () => render(`<div class="loading"><span class="spinner" aria-label="Loading"></span></div>`);

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
const hashHostKey = (code, key) => sha256(`secret-santa-host:${code}:${key}`);

function makeHostKey() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 20; i++) s += chars[randInt(chars.length)];
  return s;
}

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

// The host key lets this device open the host view (who has set a PIN).
const hostStorageKey = (code) => `secret-santa-host:${code}`;
function loadHostKey(code) {
  try { return localStorage.getItem(hostStorageKey(code)); } catch { return null; }
}
function saveHostKey(code, key) {
  try { localStorage.setItem(hostStorageKey(code), key); } catch { /* private mode */ }
}

/* ---------- Links & routing ---------- */
function groupUrl(code) {
  const u = new URL(location.href);
  u.search = `?g=${code}`;
  u.hash = "";
  return u.toString();
}

const hostUrl = (code, key) => `${groupUrl(code)}#host=${key}`;

function go(code) {
  history.pushState(null, "", code ? `?g=${code}` : location.pathname);
  route();
}

async function copyLink(code, btn, url = groupUrl(code)) {
  try {
    await navigator.clipboard.writeText(url);
    const original = btn.innerHTML;
    btn.innerHTML = bi("Link copied!", "링크가 복사되었습니다!");
    setTimeout(() => { btn.innerHTML = original; }, 1800);
  } catch {
    window.prompt("Copy this link / 이 링크를 복사하세요", url);
  }
}

async function route() {
  if (!configured) return renderSetup();
  const code = (new URLSearchParams(location.search).get("g") || "").trim().toUpperCase();
  if (!code) return renderHome();
  if (!CODE_RE.test(code)) {
    history.replaceState(null, "", location.pathname);
    return renderHome(MSG.badCode);
  }
  return openGroup(code);
}

window.addEventListener("popstate", route);
window.addEventListener("hashchange", () => { if (location.hash.includes("host=")) route(); });
const brand = document.getElementById("brand");
brand.addEventListener("click", () => go(null));
brand.addEventListener("keydown", (e) => { if (e.key === "Enter") go(null); });

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
  render(`
    <section class="card stack">
      <h2>${bi("Create a new group", "새 그룹 만들기")}</h2>
      ${instr("Start a Secret Santa for your friends, family, or team.", "친구, 가족, 팀과 함께 시크릿 산타를 시작하세요.")}
      <button id="create">${bi("Create group", "그룹 만들기")}</button>
    </section>

    <section class="card">
      <h2>${bi("Join a group", "그룹 참여하기")}</h2>
      ${instr("Enter the 6-letter code from your host.", "호스트에게 받은 6자리 코드를 입력하세요.")}
      <form id="join" class="stack" novalidate>
        <input id="code" class="code-input" maxlength="6" placeholder="ABCDEF"
          autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
          aria-label="Group code / 그룹 코드">
        <button type="submit">${bi("Join", "참여하기")}</button>
      </form>
      <div id="join-msg"></div>
    </section>`);

  $("#create").addEventListener("click", renderCreate);

  const input = $("#code");
  input.addEventListener("input", () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  });
  $("#join").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!CODE_RE.test(code)) return showMsg($("#join-msg"), "error", MSG.badCode);
    go(code);
  });

  if (error) showMsg($("#join-msg"), "error", error);
}

function renderCreate() {
  const names = [];

  render(`
    <section class="card stack">
      <h2>${bi("Create a new group", "새 그룹 만들기")}</h2>
      ${instr(
        `Add the name of everyone who's joining, including yourself if you're playing. You need at least ${MIN_PEOPLE} people.`,
        `본인을 포함해 참여하는 모든 사람의 이름을 추가하세요. 최소 ${MIN_PEOPLE}명이 필요합니다.`
      )}
      <form id="add" class="row" novalidate>
        <input id="name" maxlength="${MAX_NAME}" placeholder="Name · 이름" autocomplete="off" aria-label="Name / 이름">
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
      <button id="generate" disabled>${bi("Generate group code", "그룹 코드 생성")}</button>
      <div id="gen-msg"></div>
    </section>

    <button class="btn-ghost" id="back">${bi("← Back", "← 뒤로")}</button>`);

  const input = $("#name");
  const genBtn = $("#generate");

  function draw() {
    $("#chips").innerHTML = names
      .map(
        (n, i) => `<li class="chip">${esc(n)}
          <button type="button" data-remove="${i}" aria-label="Remove ${esc(n)} / 삭제">×</button></li>`
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
    if (names.length < MIN_PEOPLE) return;
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
      const hostKey = makeHostKey();
      await setDoc(groupRef(code), {
        names: [...names],
        giftees: makeAssignments(names.length),
        hostKeyHash: await hashHostKey(code, hostKey),
        createdAt: serverTimestamp(),
      });
      saveHostKey(code, hostKey);
      renderCreated(code, hostKey);
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

function renderCreated(code, hostKey) {
  render(`
    <section class="card stack center">
      <h2>${bi("Your group is ready!", "그룹이 준비되었어요!")}</h2>
      ${instr("Share this code or link with everyone in the group.", "이 코드나 링크를 그룹의 모든 사람에게 공유하세요.")}
      <div class="code-display">${code}</div>
      <button id="copy">${bi("Copy group link", "그룹 링크 복사")}</button>
      <button class="btn-secondary" id="open">${bi("Open group", "그룹 열기")}</button>
    </section>

    <section class="card stack">
      <h2>${bi("Host view", "호스트 화면")}</h2>
      ${instr(
        "See who has joined and set their PIN. This device remembers you as the host. To check from another device, save the private host link and don't share it.",
        "누가 참여해서 PIN을 설정했는지 확인할 수 있습니다. 이 기기는 호스트로 기억됩니다. 다른 기기에서 확인하려면 비공개 호스트 링크를 저장하고, 다른 사람과 공유하지 마세요."
      )}
      <button id="host">${bi("Open host view", "호스트 화면 열기")}</button>
      <button class="btn-secondary" id="copy-host">${bi("Copy private host link", "비공개 호스트 링크 복사")}</button>
    </section>

    <section class="card">
      ${instr(
        "Everyone has already been assigned, and it's kept secret. Not even you, the host, can see who got whom.",
        "모든 배정은 이미 완료되었으며 비밀로 유지됩니다. 호스트인 당신도 누가 누구에게 선물하는지 볼 수 없어요."
      )}
    </section>`);

  $("#copy").addEventListener("click", (e) => copyLink(code, e.currentTarget));
  $("#copy-host").addEventListener("click", (e) => copyLink(code, e.currentTarget, hostUrl(code, hostKey)));
  $("#open").addEventListener("click", () => go(code));
  $("#host").addEventListener("click", () => openGroup(code, { hostView: true }));
}

function renderHostView(code, group) {
  const hostKey = loadHostKey(code);
  const total = group.names.length;

  render(`
    <section class="card">
      <h2>${bi("Host view", "호스트 화면")}</h2>
      ${instr(
        "Here's who has set their PIN so far. Assignments stay hidden.",
        "지금까지 PIN을 설정한 사람을 확인할 수 있습니다. 배정 결과는 공개되지 않습니다."
      )}
      <p class="progress" id="progress"></p>
      <div class="progress-bar"><span id="bar"></span></div>
      <ul class="status-list" id="status"></ul>
    </section>

    <section class="card stack center">
      ${instr(
        "Send the group link to anyone who hasn't joined yet.",
        "아직 참여하지 않은 사람에게 그룹 링크를 보내세요."
      )}
      <div class="code-display">${code}</div>
      <button id="copy">${bi("Copy group link", "그룹 링크 복사")}</button>
      ${hostKey ? `<button class="btn-secondary" id="copy-host">${bi("Copy private host link", "비공개 호스트 링크 복사")}</button>` : ""}
    </section>

    <button class="btn-ghost" id="back">${bi("← Back to group", "← 그룹으로 돌아가기")}</button>`);

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
          <span class="status-badge">${ok ? bi("✓ PIN set", "PIN 설정됨") : bi("Waiting", "대기 중")}</span>
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

  $("#copy").addEventListener("click", (e) => copyLink(code, e.currentTarget));
  if (hostKey) $("#copy-host").addEventListener("click", (e) => copyLink(code, e.currentTarget, hostUrl(code, hostKey)));
  $("#back").addEventListener("click", () => openGroup(code));
}

// Small "Host view" button shown on group pages for the host's device.
const hostButton = (code) =>
  loadHostKey(code) ? `<button class="btn-secondary" id="host-view">${bi("Host view", "호스트 화면")}</button>` : "";
function wireHostButton(code) {
  const b = $("#host-view");
  if (b) b.addEventListener("click", () => openGroup(code, { hostView: true }));
}

async function openGroup(code, { hostView = false } = {}) {
  if (new URLSearchParams(location.search).get("g") !== code) {
    history.pushState(null, "", `?g=${code}`);
  }
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

  // A private host link looks like ?g=CODE#host=KEY.
  const linkKey = new URLSearchParams(location.hash.slice(1)).get("host");
  if (linkKey) {
    history.replaceState(null, "", `?g=${code}`);
    if (group.hostKeyHash && (await hashHostKey(code, linkKey)) === group.hostKeyHash) {
      saveHostKey(code, linkKey);
      hostView = true;
    }
  }
  if (hostView && loadHostKey(code)) return renderHostView(code, group);

  const session = loadSession(code);
  if (session && session.pinHash && group.names[session.memberId] !== undefined) {
    return renderDashboard(code, group, session);
  }
  return renderPicker(code, group);
}

function renderPicker(code, group) {
  render(`
    <section class="card">
      <h2>${bi("Select your name", "본인의 이름을 선택하세요")}</h2>
      ${instr("Tap your own name to continue.", "계속하려면 본인의 이름을 누르세요.")}
      <div class="name-grid">
        ${group.names.map((n, i) => `<button class="btn-secondary" data-i="${i}">${esc(n)}</button>`).join("")}
      </div>
    </section>
    ${hostButton(code)}
    <button class="btn-ghost" id="home">${bi("← Home", "← 홈으로")}</button>`);

  app.querySelectorAll("[data-i]").forEach((b) =>
    b.addEventListener("click", () => renderPin(code, group, Number(b.dataset.i)))
  );
  $("#home").addEventListener("click", () => go(null));
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
        placeholder="e.g. cozy socks, a good book, coffee beans…&#10;예: 포근한 양말, 좋은 책, 원두…"
        aria-label="My wishlist / 나의 위시리스트"></textarea>
      <button id="save">${bi("Save wishlist", "위시리스트 저장")}</button>
      <div id="save-msg"></div>
    </section>

    <section class="card stack center">
      <h2>${bi("Invite others", "다른 사람 초대하기")}</h2>
      ${instr(
        "Share the group code or link with anyone who hasn't joined yet.",
        "아직 참여하지 않은 사람에게 그룹 코드나 링크를 공유하세요."
      )}
      <div class="code-display">${code}</div>
      <button class="btn-secondary" id="copy">${bi("Copy link", "링크 복사")}</button>
      ${hostButton(code)}
    </section>`);
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
  $("#copy").addEventListener("click", (e) => copyLink(code, e.currentTarget));
}

/* ---------- Start ---------- */
route();
