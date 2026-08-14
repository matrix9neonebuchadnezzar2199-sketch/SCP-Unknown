#!/usr/bin/env python3
"""SCP-Unknown 回帰ランナー。

修正のたびに実行する:  python TEST.py
失敗したら直してから再実行する。exit 0 が緑、1 が破損。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JS_FILES = ("data.js", "game.js", "sector.js")
REQUIRED = JS_FILES + ("index.html", "LICENSE", "ATTRIBUTION.md", "database.rules.json")

HARNESS = r"""
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const crypto = require("crypto");

const root = process.argv[2];
const store = Object.create(null);
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};

const ctx = {
  console,
  Date, Math, JSON, Set, Map, Object, Array, Number, String, Boolean, Error,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, undefined,
  crypto: crypto.webcrypto || crypto,
  localStorage,
  performance: { now: () => Date.now() },
  window: {},
  document: { getElementById: () => null },
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
function loadScript(name) {
  const src = fs.readFileSync(path.join(root, name), "utf8");
  vm.runInContext(src + "\nif (typeof GAME_DATA !== 'undefined') this.GAME_DATA = GAME_DATA;", ctx, { filename: name });
}
loadScript("data.js");
loadScript("game.js");
loadScript("sector.js");

const fails = [];
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fails.push(`${name}: got ${a}, want ${b}`);
}
function ok(name, cond, detail) {
  if (!cond) fails.push(detail ? `${name}: ${detail}` : name);
}

const G = ctx.GAME_DATA;
ok("GAME_DATA", !!G, "missing");
ok("version", typeof G.version === "string" && G.version.length > 0);

const ids = new Set();
function claim(id, where) {
  ok(`${where} id`, typeof id === "string" && id.length > 0, String(id));
  if (ids.has(id)) fails.push(`duplicate id ${id} in ${where}`);
  ids.add(id);
}
for (const p of G.parts) claim(p.id, "parts");
for (const o of G.recoveryObjects) claim(o.id, "objects");
for (const a of G.artifacts) claim(a.id, "artifacts");
for (const g of G.gear) claim(g.id, "gear");
for (const a of G.attachments || []) claim(a.id, "attachments");
for (const cid of Object.keys(G.catalog)) claim(cid, "catalog");

ok("floors", G.floors.length === 50, `len=${G.floors.length}`);
ok("starters", G.starters.length === 3);
for (const sid of G.starters) ok(`starter ${sid}`, !!G.catalog[sid]);
ok("mapSites", Array.isArray(G.mapSites) && G.mapSites.length >= 1);

for (const [sid, sk] of Object.entries(G.skills)) {
  ok(`skill.id ${sid}`, sk.id === sid);
}
for (const [cid, cat] of Object.entries(G.catalog)) {
  ok(`catalog.base ${cid}`, cat.base && typeof cat.base.hp === "number");
  for (const skillId of cat.skills || []) {
    ok(`catalog skill ${cid}.${skillId}`, !!G.skills[skillId]);
  }
}
for (const rec of G.crossRecipes) {
  ok(`recipe parent ${rec.parents[0]}`, !!G.catalog[rec.parents[0]]);
  ok(`recipe parent ${rec.parents[1]}`, !!G.catalog[rec.parents[1]]);
  ok(`recipe child ${rec.child}`, !!G.catalog[rec.child]);
}
for (const item of [...G.parts, ...G.recoveryObjects, ...G.artifacts, ...G.gear, ...(G.attachments || [])]) {
  if (!item.craft) continue;
  for (const pid of Object.keys(item.craft)) {
    ok(`craft mat ${item.id}.${pid}`, ctx.itemMeta(pid) != null);
  }
  if (!ctx.dismantleYield(item.id)) continue;
  const sim = ctx.createNewState();
  sim.budget = 100000;
  for (const p of G.parts) sim.parts[p.id] = 500;
  for (const [pid, n] of Object.entries(item.craft)) {
    if (!ctx.isPart(pid)) ctx.storageAdd(sim, pid, n + 5);
  }
  const beforeParts = { ...sim.parts };
  const beforeBudget = sim.budget;
  const beforeObj = {};
  for (const pid of Object.keys(item.craft)) {
    if (!ctx.isPart(pid)) beforeObj[pid] = ctx.storageCount(sim, pid);
  }
  const made = ctx.craftItem(sim, item.id, 1);
  ok(`craft ${item.id}`, made.ok, made.msg);
  const idx = sim.storage.findIndex((x) => x && x.id === item.id);
  ok(`crafted slot ${item.id}`, idx >= 0);
  if (idx >= 0) ctx.dismantleStorageSlot(sim, idx, 1);
  for (const p of G.parts) {
    ok(`no part profit ${item.id}.${p.id}`, (sim.parts[p.id] || 0) <= (beforeParts[p.id] || 0));
  }
  for (const [pid, n] of Object.entries(beforeObj)) {
    ok(`no obj profit ${item.id}.${pid}`, ctx.storageCount(sim, pid) <= n);
  }
  ok(`no budget profit ${item.id}`, sim.budget <= beforeBudget);
}

const s0 = ctx.createNewState();
eq("new.budget", s0.budget, 100);
eq("new.units", s0.units.length, 3);
eq("new.storage", s0.storage.length, G.storageDefaults.slots);
eq("new.squad", s0.squad.length, 3);
ok("guest name", /^Guest-[0-9A-F]{6}$/.test(s0.profile.codename), s0.profile.codename);

ok("gun uid", ctx.needsWeaponUid("eq_rifle") === true);
ok("blade no uid", ctx.needsWeaponUid("eq_baton") === false);
ok("art_blade no uid", ctx.needsWeaponUid("art_blade") === false);
ok("pistol no uid", ctx.needsWeaponUid("eq_pistol") === false);

const sGun = ctx.createNewState();
eq("add rifle leftover", ctx.storageAdd(sGun, "eq_rifle", 3), 0);
const rifles = sGun.storage.filter((x) => x && x.id === "eq_rifle");
eq("rifle slots", rifles.length, 3);
ok("rifle qty 1", rifles.every((r) => r.qty === 1));
ok("rifle unique uid", new Set(rifles.map((r) => r.uid)).size === 3);

const sBlade = ctx.createNewState();
eq("add baton leftover", ctx.storageAdd(sBlade, "eq_baton", 5), 0);
const bats = sBlade.storage.filter((x) => x && x.id === "eq_baton");
eq("baton stacks", bats.length, 1);
eq("baton qty", bats[0].qty, 5);
ok("baton no uid", !bats[0].uid);

const sAtt = ctx.createNewState();
eq("add attach leftover", ctx.storageAdd(sAtt, "att_reddot", 2), 0);
const atts = sAtt.storage.filter((x) => x && x.id === "att_reddot");
eq("attach no stack", atts.length, 2);
ok("attach qty 1", atts.every((a) => a.qty === 1));

const sLoad = ctx.createNewState();
ctx.storageAdd(sLoad, "eq_rifle", 1);
ctx.storageAdd(sLoad, "att_reddot", 1);
const gunUid = sLoad.storage.find((x) => x && x.id === "eq_rifle").uid;
const attIdx = sLoad.storage.findIndex((x) => x && x.id === "att_reddot");
const beforeQty = sLoad.storage[attIdx].qty;
const attRes = ctx.attachToWeapon(sLoad, gunUid, "sight", attIdx);
ok("attach ok", attRes.ok, attRes.msg);
eq("attach not consumed", sLoad.storage[attIdx] && sLoad.storage[attIdx].qty, beforeQty);
ok("loadout saved", !!sLoad.weaponLoadouts[gunUid].sight);

const sEq = ctx.createNewState();
ctx.storageAdd(sEq, "eq_helm", 1);
const helmIdx = sEq.storage.findIndex((x) => x && x.id === "eq_helm");
const eqRes = ctx.equipOperator(sEq, "head", "eq_helm", helmIdx);
ok("equip ok", eqRes.ok, eqRes.msg);
ok("equipped", ctx.equippedItemId(sEq.operatorGear.head) === "eq_helm");
eq("helm left storage", ctx.storageCount(sEq, "eq_helm"), 0);
const unRes = ctx.unequipOperator(sEq, "head");
ok("unequip ok", unRes.ok, unRes.msg);
eq("helm returned", ctx.storageCount(sEq, "eq_helm"), 1);

const sSave = ctx.createNewState();
sSave.battleLog = ["should drop"];
sSave.lastExplore = { x: 1 };
sSave.stamina = 10;
sSave.staminaUpdatedAt = Date.now() - G.staminaRegenMs * 3;
sSave.chatLog.push({ channel: "all", user: "Guest-ABC123", text: "player line", ts: Date.now() });
sSave.chatLog.push({ channel: "question", user: "Guest-ABC123", text: "q line", ts: Date.now() });
const payload = ctx.sanitizeStateForSave(sSave);
ok("omit battleLog", payload.battleLog === undefined);
ok("omit lastExplore", payload.lastExplore === undefined);
ok("omit equipped", payload.equipped === undefined);
ok("omit staminaMax", payload.staminaMax === undefined);
ok("omit chamberMax", payload.chamberMax === undefined);
ok("keep commander", payload.chatLog.some((m) => m.user === "指揮官"));
ok("drop player all", !payload.chatLog.some((m) => m.user === "Guest-ABC123" && m.channel === "all"));
ok("keep question", payload.chatLog.some((m) => m.channel === "question"));
ok("live battleLog intact", sSave.battleLog.length === 1);

ctx.saveGame(sSave);
const loaded = ctx.loadGame();
ok("loaded", !!loaded);
ok("stamina finite", Number.isFinite(loaded.stamina), String(loaded.stamina));
ok("staminaMax number", typeof loaded.staminaMax === "number");
eq("stamina regen", loaded.stamina, 13);
eq("staminaMax site1", loaded.staminaMax, G.staminaMaxBase);

const sMig = ctx.createNewState();
delete sMig.seededMaxAttach;
ctx.migrateState(sMig);
const attAfter = sMig.storage.filter((x) => x && ctx.itemMeta(x.id)?.kind === "attach");
eq("migrate no free attach", attAfter.length, 0);

const sGuest = { profile: { codename: "D-Class-427", clearance: 2, title: "収容担当" }, units: [], squad: [], storage: [], parts: ctx.emptyPartsBag(), pending: [], chatLog: [] };
sGuest.operatorGear = ctx.emptyOperatorGear();
ctx.migrateState(sGuest);
ok("guest migrated", sGuest.profile.codename !== "D-Class-427");
ok("guest flag", sGuest.guestCodenameMigrated === true);
const oldName = sGuest.profile.codename;
ctx.migrateState(sGuest);
eq("guest migrate once", sGuest.profile.codename, oldName);

const sMerge = ctx.createNewState();
sMerge.storage[0] = { id: "eq_baton", qty: 1, uid: "w1" };
sMerge.storage[1] = { id: "eq_baton", qty: 1, uid: "w2" };
sMerge.weaponLoadouts = { w1: {}, w2: {} };
sMerge.mergedNonGunWeapons = false;
ctx.migrateNonGunWeaponStacks(sMerge);
const mergedBaton = sMerge.storage.filter((x) => x && x.id === "eq_baton");
eq("merged baton slots", mergedBaton.length, 1);
eq("merged baton qty", mergedBaton[0].qty, 2);
ok("merged no uid", !mergedBaton[0].uid);

eq("kills 1", ctx.killsNeeded(1), 6);
eq("kills 12", ctx.killsNeeded(12), 28);
eq("maxLv 0", ctx.maxLevel(0), 30);
eq("maxLv 1", ctx.maxLevel(1), 40);

const u = ctx.createUnit("scp131", 1, 0);
ctx.addXp(u, ctx.xpForLevel(1));
eq("level up", u.level, 2);

const sCraft = ctx.createNewState();
sCraft.budget = 10000;
sCraft.parts.p_alloy = 50;
sCraft.parts.p_circuit = 20;
const emptyKeep = 3;
for (let i = 0; i < sCraft.storage.length - emptyKeep; i++) {
  sCraft.storage[i] = { id: "obj_wire", qty: 1 };
}
const maxGuns = ctx.maxCraftCount(sCraft, "eq_rifle");
eq("craft guns = empty slots", maxGuns, emptyKeep);
const over = ctx.craftItem(sCraft, "eq_rifle", emptyKeep + 1);
ok("craft overflow blocked", over.ok === false);

const sCross = ctx.createNewState();
const pa = ctx.createUnit("scp049", 5, 0);
const pb = ctx.createUnit("scp173", 5, 0);
pa.uid = ctx.uid(sCross);
pb.uid = ctx.uid(sCross);
sCross.units.push(pa, pb);
const beforeUnits = sCross.units.length;
const preview = ctx.previewCross(sCross, pa.uid, pb.uid);
eq("preview child", preview.childCatalogId, "x049_173");
ok("preview recipe", preview.recipe === true);
eq("preview no mutate", sCross.units.length, beforeUnits);
const cross = ctx.crossTest(sCross, pa.uid, pb.uid);
ok("cross ok", cross.ok, cross.msg);
eq("cross child", cross.child.catalogId, "x049_173");
ok("inherited set", Array.isArray(cross.child.inheritedSkills) && cross.child.inheritedSkills.length > 0);
const childSkills = ctx.getUnitSkills(cross.child).map((sk) => sk.id);
ok("inherited used", childSkills.includes("plague_touch") || childSkills.includes("snap_neck"), childSkills.join(","));

const sSite = ctx.createNewState();
sSite.budget = 1;
const up = ctx.upgradeSite(sSite);
ok("upgrade blocked", up.ok === false);
eq("site stays", sSite.siteLevel, 1);

ok("spend fail", ctx.spendStamina(s0, 999) === false);

const secA = ctx.generateSector(3, "s8102");
const secB = ctx.generateSector(3, "s8102");
eq("sector rooms det", secA.rooms.length, secB.rooms.length);
ok("sector rooms >=8", secA.rooms.length >= 8, String(secA.rooms.length));
ok("sector path", Array.isArray(ctx.findRoomPath(secA, 0, secA.rooms.length - 1)));

const secC = ctx.generateSector(3, "s8104");
const layoutA = JSON.stringify(secA.rooms.map((r) => [r.code, r.x, r.y]));
const layoutC = JSON.stringify(secC.rooms.map((r) => [r.code, r.x, r.y]));
ok("sector site differs", layoutA !== layoutC, "same layout for different sites");

const clonedAmmo = ctx.cloneSentries([{ x: 10, y: 20, ammo: 40 }]);
eq("clone sentry ammo", clonedAmmo[0].ammo, 40);
const clonedDefault = ctx.cloneSentries([{ x: 1, y: 2 }]);
eq("clone sentry ammo default", clonedDefault[0].ammo, 100);
const simExpire = { sentries: [{ x: 0, y: 0, ammo: 0, emptyAtMs: Date.now() - 11000 }] };
ok("expire empty sentry", ctx.expireEmptySentries(simExpire) === true && simExpire.sentries.length === 0);
const simKeep = { sentries: [{ x: 0, y: 0, ammo: 0, emptyAtMs: Date.now() }] };
ok("keep empty sentry 10s", ctx.expireEmptySentries(simKeep) === false && simKeep.sentries.length === 1);

if (fails.length) {
  console.error("FAIL " + fails.length);
  for (const f of fails) console.error(" - " + f);
  process.exit(1);
}
console.log("OK " + "logic tests passed");
"""


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")


def main() -> int:
    failed = 0
    warnings: list[str] = []

    for name in REQUIRED:
        path = ROOT / name
        if not path.is_file():
            print(f"FAIL missing {name}")
            failed += 1
        else:
            print(f"OK  file {name}")

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    if "let equipSkillOnly = false;" not in html:
        print("FAIL index.html に let equipSkillOnly = false; が無い")
        failed += 1
    else:
        print("OK  equipSkillOnly declared")
    if "escapeHtml(m.user)" not in html:
        print("FAIL チャット表示で m.user が escape されていない")
        failed += 1
    else:
        print("OK  chat user escaped")
    if "firebase-app-compat.js" not in html:
        print("FAIL Firebase SDK 参照が無い")
        failed += 1
    else:
        print("OK  Firebase SDK present")
    if "function startPresence" not in html or "function updateChatFooter" not in html:
        print("FAIL オンライン人数（presence / footer）が無い")
        failed += 1
    else:
        print("OK  presence footer")

    rules = (ROOT / "database.rules.json").read_text(encoding="utf-8")
    if '"presence"' not in rules or "auth.uid === $uid" not in rules:
        print("FAIL database.rules.json に presence ルールが無い")
        failed += 1
    else:
        print("OK  presence rules")

    if "id=\"sentry-ammo-col\"" not in html or "function updateSentryAmmoHud" not in html:
        print("FAIL セントリー残弾 HUD が無い")
        failed += 1
    else:
        print("OK  sentry ammo hud")
    sector_src = (ROOT / "sector.js").read_text(encoding="utf-8")
    if "const SENTRY_AMMO_MAX = 100" not in sector_src or "const SENTRY_EMPTY_MS = 10000" not in sector_src:
        print("FAIL sector.js の残弾定数が無い")
        failed += 1
    else:
        print("OK  sentry ammo constants")

    game = (ROOT / "game.js").read_text(encoding="utf-8")
    for needle, label in (
        ("function sanitizeStateForSave", "sanitizeStateForSave"),
        ("needsWeaponUid", "needsWeaponUid"),
        ('SAVE_KEY = "scp-unknown-save-v1"', "SAVE_KEY"),
        ("seedMaxAttachmentsForVerify", "verify helper kept"),
    ):
        if needle not in game:
            print(f"FAIL game.js に {label} が無い")
            failed += 1
        else:
            print(f"OK  {label}")

    # migrate から検証シードを呼ぶと倉庫が汚染される
    if "seedMaxAttachmentsForVerify(state);" in game:
        print("FAIL seedMaxAttachmentsForVerify がどこかから呼ばれている（migrate 禁止）")
        failed += 1
    else:
        print("OK  migrate does not seed attachments")

    node = run(["node", "--version"])
    if node.returncode != 0:
        print("FAIL node が使えない（ロジックテスト不可）")
        print(node.stderr or node.stdout)
        return 1
    print(f"OK  {node.stdout.strip()}")

    for name in JS_FILES:
        chk = run(["node", "--check", str(ROOT / name)])
        if chk.returncode != 0:
            print(f"FAIL syntax {name}")
            print(chk.stderr)
            failed += 1
        else:
            print(f"OK  syntax {name}")

    harness_path = ROOT / "_test_harness.js"
    try:
        harness_path.write_text(HARNESS, encoding="utf-8")
        logic = run(["node", str(harness_path), str(ROOT)])
        sys.stdout.write(logic.stdout)
        if logic.returncode != 0:
            sys.stderr.write(logic.stderr)
            print("FAIL logic harness")
            failed += 1
        else:
            print("OK  logic harness")
    finally:
        if harness_path.exists():
            harness_path.unlink()

    # アイコン欠損は警告。ゲームロジック破損ではない
    data_js = (ROOT / "data.js").read_text(encoding="utf-8")
    item_ids = re.findall(r'id:\s*"(p_[a-z0-9]+|obj_[a-z0-9]+|art_[a-z0-9]+|eq_[a-z0-9]+|att_[a-z0-9]+)"', data_js)
    item_dir = ROOT / "assets" / "item"
    for iid in sorted(set(item_ids)):
        png = item_dir / f"{iid}.png"
        if not png.is_file():
            warnings.append(f"missing assets/item/{iid}.png")
    catalog_ids = re.findall(r"^\s{2,4}(scp[a-z0-9]+|x[0-9a-z_]+):\s*\{", data_js, re.M)
    scp_dir = ROOT / "assets" / "scp"
    for cid in sorted(set(catalog_ids)):
        png = scp_dir / f"{cid}.png"
        if not png.is_file():
            warnings.append(f"missing assets/scp/{cid}.png")

    for w in warnings:
        print(f"WARN {w}")

    print("-----")
    if failed:
        print(f"RESULT FAIL ({failed})  WARN {len(warnings)}")
        print("壊れている。修正して python TEST.py を再実行すること。")
        return 1
    print(f"RESULT PASS  WARN {len(warnings)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
