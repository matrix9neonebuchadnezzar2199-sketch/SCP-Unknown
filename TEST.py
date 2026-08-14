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
{
  const fd = ctx.currentFloorData(ctx.createNewState());
  ok("floor label /50", typeof fd.name === "string" && /-\d+\/50$/.test(fd.name), String(fd.name));
}
const tree = G.siteTree;
ok("siteTree", tree && Array.isArray(tree.nodes) && tree.nodes.length >= 20);
const treeIds = new Set();
const treeIcons = new Set();
for (const n of tree.nodes) {
  ok(`tree node ${n.id}`, typeof n.id === "string" && n.id.length > 0 && !treeIds.has(n.id));
  treeIds.add(n.id);
  ok(`tree xy ${n.id}`, typeof n.x === "number" && typeof n.y === "number");
  ok(`tree icon ${n.id}`, typeof n.icon === "string" && n.icon.length > 0);
  treeIcons.add(n.icon);
}
ok("tree unique icons", treeIcons.size >= 20, `n=${treeIcons.size}`);
ok("tree start", treeIds.has(tree.startId));
for (const [a, b] of tree.edges) {
  ok(`tree edge ${a}-${b}`, treeIds.has(a) && treeIds.has(b));
}
const sTree = ctx.createNewState();
ok("tree start alloc", sTree.siteNodes.includes("n_start"));
eq("unspent lv1", ctx.sitePointsUnspent(sTree), 3);
ok("keystone locked", ctx.allocateSiteNode(sTree, "n_sk").ok === false);
ok("alloc s1", ctx.allocateSiteNode(sTree, "n_s1").ok);
eq("spent 1", ctx.sitePointsSpent(sTree), 1);
eq("sentry ammo +4", ctx.sitePassives(sTree).sentryAmmo, 4);
eq("sentry max base", ctx.sentryMaxOf(sTree), 2);

const sGear = ctx.createNewState();
ok("g1", ctx.allocateSiteNode(sGear, "n_g1").ok);
ok("g2", ctx.allocateSiteNode(sGear, "n_g2").ok);
ok("g3", ctx.allocateSiteNode(sGear, "n_g3").ok);
eq("mat 10off", Math.round(ctx.sitePassives(sGear).enhanceMat * 100), 90);
const costBase = ctx.gearEnhanceCostRange(0, 20);
const costOff = ctx.gearEnhanceCostRange(0, 20, sGear);
ok("enhance mats off", (costOff.mats.p_scrap || 0) < (costBase.mats.p_scrap || 0), `${costOff.mats.p_scrap} vs ${costBase.mats.p_scrap}`);

const sD = ctx.createNewState();
ok("d1", ctx.allocateSiteNode(sD, "n_d1").ok);
ctx.storageAdd(sD, "eq_helm", 1);
const helmSlot = sD.storage.findIndex((x) => x && x.id === "eq_helm");
const rnd = Math.random;
Math.random = () => 0;
const beforeScrap = ctx.storageCount(sD, "p_scrap");
const dis = ctx.dismantleStorageSlot(sD, helmSlot, 1);
Math.random = rnd;
ok("dismantle ok", dis.ok, dis.msg);
ok("dismantle bonus text", String(dis.msg).includes("選別"), dis.msg);
{
  const sY = ctx.createNewState();
  eq("scrap empty", ctx.storageDismantlePartQty(sY, "p_anomalon"), 0);
  ctx.storageAdd(sY, "obj_timeshard", 2);
  eq("scrap timeshard anomalon", ctx.storageDismantlePartQty(sY, "p_anomalon"), 6);
  eq("scrap timeshard cell", ctx.storageDismantlePartQty(sY, "p_cell"), 2);
}
eq("part helm", ctx.gearPartFilterId("eq_helm"), "head");
eq("part rifle", ctx.gearPartFilterId("eq_rifle"), "gun");
eq("part baton", ctx.gearPartFilterId("eq_baton"), "blade");
eq("part vest", ctx.gearPartFilterId("eq_vest"), "armor");
eq("part name helm", ctx.gearPartName("eq_helm"), "頭");
eq("part name rifle", ctx.gearPartName("eq_rifle"), "銃");
eq("part attach id", ctx.gearPartFilterId("att_reddot"), "attach");
eq("part attach name", ctx.gearPartName("att_reddot"), "サイト");
ok("gearParts", Array.isArray(G.gearParts) && G.gearParts.length >= 8);
const sMap = ctx.createNewState();
const pick = G.mapSites.find((s) => s.id !== sMap.mapSite && !s.limited) || G.mapSites[0];
const rMap = ctx.selectMapSite(sMap, pick.id);
ok("selectMapSite", rMap.ok, rMap.msg);
eq("mapSite set", sMap.mapSite, pick.id);
{
    const lim = G.mapSites.find((s) => s.limited);
    ok("limited site", !!lim && lim.id === "s8103", lim && lim.id);
    eq("limited run ms", lim.limitedRunMs, 600000);
    eq("unlock anomalon", lim.unlockCost && lim.unlockCost.p_anomalon, 1);
    eq("unlock cell", lim.unlockCost && lim.unlockCost.p_cell, 1);
    const sLim = ctx.createNewState();
    ok("limited locked no mats", ctx.selectMapSite(sLim, lim.id).ok === false);
    ctx.storageAdd(sLim, "p_anomalon", 1);
    ctx.storageAdd(sLim, "p_cell", 1);
    ok("limited unlock", ctx.selectMapSite(sLim, lim.id).ok);
    eq("anomalon spent", ctx.storageCount(sLim, "p_anomalon"), 0);
    eq("cell spent", ctx.storageCount(sLim, "p_cell"), 0);
    ok("run active", ctx.isLimitedRunActive(sLim, lim.id));
    const remain = ctx.limitedRunRemainMs(sLim);
    ok("remain ~10m", remain > 590000 && remain <= 600000, String(remain));
    ctx.addInventory(sLim, "p_scrap", 3);
    const lootRow = (sLim.limitedRun.loot || []).find((x) => x.id === "p_scrap");
    eq("run loot scrap", lootRow && lootRow.qty, 3);
    ctx.storageAdd(sLim, "p_anomalon", 1);
    ctx.storageAdd(sLim, "p_cell", 1);
    ok("reenter", ctx.selectMapSite(sLim, lim.id).ok);
    eq("no double spend", ctx.storageCount(sLim, "p_anomalon"), 1);
    const other = G.mapSites.find((s) => !s.limited);
    ok("cannot leave", ctx.selectMapSite(sLim, other.id).ok === false);
    sLim.limitedRun.until = Date.now() - 1;
    ok("needs extract", ctx.limitedRunNeedsExtract(sLim));
    const loot = ctx.concludeLimitedRun(sLim);
    ok("loot returned", Array.isArray(loot) && loot.some((x) => x.id === "p_scrap"));
    eq("run cleared", sLim.limitedRun, null);
    eq("osprey hq", sLim.ospreyAtHq, true);
    eq("left 8103", sLim.mapSite, G.defaultMapSite);
    ok("exclusive filtered A", !(ctx.poolForRarity("A") || []).some((o) => o.id === "obj_timeshard"));
    ok("exclusive filtered S", !(ctx.poolForRarity("S") || []).some((o) => o.id === "art_hourglass"));
}
{
    const all = ctx.craftableList();
    const gear = new Set(["gear", "attach"]);
    const item = new Set(["part", "object", "artifact"]);
    ok("craft kinds known", all.every((m) => gear.has(m.kind) || item.has(m.kind)));
    ok("gear shop nonempty", all.some((m) => gear.has(m.kind)));
    ok("item shop nonempty", all.some((m) => item.has(m.kind)));
}
{
    const sB = ctx.createNewState();
    const br = ctx.runBattle(sB, ctx.currentFloorData(sB));
    ok("allyCards", Array.isArray(br.allyCards) && br.allyCards.length >= 1);
    ok("allyCards dmg", br.allyCards.every((c) => typeof c.dmgDealt === "number" && typeof c.dmgTaken === "number"));
}

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
sSave.chatLog.push({ channel: "all", user: "指揮官", text: "flavor", ts: Date.now() });
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
ok("drop question", !payload.chatLog.some((m) => m.channel === "question"));
ok("live battleLog intact", sSave.battleLog.length === 1);

ctx.saveGame(sSave);
const loaded = ctx.loadGame();
ok("loaded", !!loaded);
ok("stamina finite", Number.isFinite(loaded.stamina), String(loaded.stamina));
ok("staminaMax number", typeof loaded.staminaMax === "number");
eq("stamina regen", loaded.stamina, 13);
eq("staminaMax site1", loaded.staminaMax, G.staminaMaxBase);

const sChatMig = ctx.createNewState();
sChatMig.chatLog = [{ channel: "question", user: "x", text: "q", ts: 1 }];
ctx.migrateState(sChatMig);
eq("migrate clears chat", sChatMig.chatLog.length, 0);

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
ok("preview stats", preview.childStats && preview.childStats.hp > 0);
ok("preview skills", Array.isArray(preview.skills) && preview.skills.length > 0);
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

const clonedAmmo = ctx.cloneSentries([{ x: 10, y: 20, ammo: 12 }]);
eq("clone sentry ammo", clonedAmmo[0].ammo, 12);
const clonedDefault = ctx.cloneSentries([{ x: 1, y: 2 }]);
eq("clone sentry ammo default", clonedDefault[0].ammo, 20);
const simExpire = { sentries: [{ x: 0, y: 0, ammo: 0, emptyAtMs: Date.now() - 11000 }] };
ok("expire empty sentry", ctx.expireEmptySentries(simExpire) === true && simExpire.sentries.length === 0);
const simKeep = { sentries: [{ x: 0, y: 0, ammo: 0, emptyAtMs: Date.now() }] };
ok("keep empty sentry 10s", ctx.expireEmptySentries(simKeep) === false && simKeep.sentries.length === 1);

const simShot = {
  reds: [{ x: 40, y: 0, dead: false, dying: false, incoming: false, roomId: 0, label: "X", waypoints: [], hp: 10, hpMax: 10 }],
  blues: [{ x: 0, y: 0, label: "展開チーム", facing: 0, fireCd: 0, burstLeft: 0, hp: 80, hpMax: 80 }],
  sentries: [],
  shots: [],
  flashes: [],
  events: [],
  contacts: 0,
  time: 0,
  depth: 1,
  sector: { rooms: [{ id: 0, code: "A-01" }] },
};
ok("acquire team shot", ctx.acquireShots(simShot, {}) === true && simShot.shots.length === 1);
eq("burst left", simShot.blues[0].burstLeft, 9);
ok("no double acquire", ctx.acquireShots(simShot, {}) === false && simShot.shots.length === 1);
const stShot = ctx.createNewState();
ctx.updateShots(simShot, stShot, 1);
ok("shot hit dmg", simShot.reds[0].hp === 9 && simShot.reds[0].dying === false);
simShot.shots = [];
simShot.blues[0].fireCd = 0;
simShot.blues[0].burstLeft = 0;
for (let i = 0; i < 9; i++) {
  simShot.blues[0].fireCd = 0;
  ctx.acquireShots(simShot, {});
  ctx.updateShots(simShot, stShot, 1);
  simShot.shots = [];
}
ok("tenth kill", simShot.reds[0].dying === true && simShot.reds[0].hp === 0);
const simConeMiss = {
  reds: [{ x: 0, y: 40, dead: false, dying: false, roomId: 0, label: "Y", waypoints: [], hp: 10, hpMax: 10 }],
  blues: [{ x: 0, y: 0, label: "展開チーム", facing: 0, fireCd: 0, burstLeft: 0 }],
  sentries: [],
  shots: [],
};
ok("cone miss", ctx.acquireShots(simConeMiss, {}) === false && simConeMiss.shots.length === 0);
const simHq = ctx.createSectorSim(ctx.createNewState(), ctx.GAME_DATA.floors[0]);
ok("hq placed", simHq.hq && typeof simHq.hq.x === "number" && typeof simHq.hq.roomId === "number");
ok("team hp", simHq.blues[0].hpMax >= 80 && simHq.blues[0].hp === simHq.blues[0].hpMax);

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
    if "探索進行" in html:
        print("FAIL 探索進行メーターが残っている")
        failed += 1
    else:
        print("OK  explore progress meter removed")
    if 'id="h-stamina-fill"' not in html:
        print("FAIL 許可証バーがヘッダーに無い")
        failed += 1
    elif "収容安定度" in html or "違反リスク推定" in html or "dash-status-meters" in html:
        print("FAIL 収容安定度／違反リスク推定が残っている")
        failed += 1
    else:
        print("OK  dash meters removed")
    if 'id="loot-summary"' not in html or "class=\"loot-icon" not in html or "ranked.slice(0, 5)" not in html:
        print("FAIL 入手整理のレア度順アイコン5件が無い")
        failed += 1
    else:
        print("OK  loot summary icons")
    if "data-result-layout" not in html or "result-team" not in html or "repeat(6" not in html:
        print("FAIL リザルトの6列カード／ダメージ比較バーが無い")
        failed += 1
    else:
        print("OK  battle result layout")
    if 'class="floor-now"' not in html:
        print("FAIL 区画探索の深度数字（floor-now）が無い")
        failed += 1
    else:
        print("OK  floor depth yellow")
    if "profile-dossier" not in html or "profile-id-card" not in html or "profile-clear" not in html:
        print("FAIL プロフィールのドシエUIが無い")
        failed += 1
    else:
        print("OK  profile dossier")
    if 'menuBtn("craftGear"' not in html or 'menuBtn("craftItem"' not in html or "収容個体生成" not in html:
        print("FAIL 拠点の装備制作／アイテム制作／収容個体生成が無い")
        failed += 1
    elif 'menuBtn("cross"' not in html.split("menu-cat tactical", 1)[0] or '"収容体合成"' not in html:
        print("FAIL 拠点の収容体合成が無い（戦術側に残っている）")
        failed += 1
    elif 'menuBtn("alchemy"' in html:
        print("FAIL 戦術に SCP-914（alchemy）メニューが残っている")
        failed += 1
    else:
        print("OK  base craft shops")
    if 'menu-cat settings' in html or 'menuBtn("help"' in html or 'menuBtn("credits"' in html:
        print("FAIL 設定メニューが残っている")
        failed += 1
    else:
        pills = html[html.find('class="stat-pills"'):html.find('class="top-actions"')]
        help_at = pills.find('data-goto="help"')
        story_at = pills.find("関連物語")
        permit_at = pills.find("許可証")
        if help_at < 0 or story_at < 0 or not (help_at < story_at < permit_at):
            print("FAIL 許可証の左に本／関連物語が無い")
            failed += 1
        else:
            print("OK  header docs left of permit")
    if 'id="notice-bar"' not in html or "function initNoticeBar" not in html:
        print("FAIL 最上部のお知らせが無い")
        failed += 1
    elif "notices:" not in (ROOT / "data.js").read_text(encoding="utf-8"):
        print("FAIL data.js に notices が無い")
        failed += 1
    else:
        print("OK  notice bar")
    if ".btn.btn-map-select" not in html or "#8eb8d4" not in html:
        print("FAIL MAP選択／←司令室の薄い青が無い")
        failed += 1
    else:
        print("OK  nav sky buttons")
    if 'id="item-hover"' not in html or "data-item-hover" not in html or "function bindItemHover" not in html:
        print("FAIL アイテムホバー詳細が無い")
        failed += 1
    else:
        print("OK  item hover inspect")
    if "function partBadgeHtml" not in html or "data-items-ptab" not in html or "data-alchemy-ptab" not in html:
        print("FAIL 装備部位バッジ／フィルタが無い")
        failed += 1
    elif "gearParts:" not in (ROOT / "data.js").read_text(encoding="utf-8"):
        print("FAIL data.js に gearParts が無い")
        failed += 1
    else:
        print("OK  gear part badges")
    if 'id="btn-chat-drawer"' not in html or "スマホ専用配置" not in html or ".squad-mini{width:48px" not in html.replace(" ", ""):
        print("FAIL スマホ専用レイアウトが無い")
        failed += 1
    else:
        print("OK  mobile layout")
    if ".squad-mini .icon, .squad-mini .catalog-art" not in html or "width: 80px; height: 80px" not in html:
        print("FAIL 展開部隊アイコン枠が 80px になっていない")
        failed += 1
    else:
        print("OK  squad frames 80px")
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
    elif '"question"' not in rules:
        print("FAIL database.rules.json に chat/question が無い")
        failed += 1
    else:
        print("OK  presence rules")
    if "attachChatListener" not in html or "mergedQuestionChat" not in html:
        print("FAIL 質問チャンネルの Firebase 共有が無い")
        failed += 1
    else:
        print("OK  question chat shared")

    if "id=\"sentry-ammo-col\"" not in html or "function updateSentryAmmoHud" not in html:
        print("FAIL セントリー残弾 HUD が無い")
        failed += 1
    else:
        print("OK  sentry ammo hud")
    sector_src = (ROOT / "sector.js").read_text(encoding="utf-8")
    if "const SENTRY_AMMO_MAX = 20" not in sector_src or "const SENTRY_EMPTY_MS = 10000" not in sector_src:
        print("FAIL sector.js の残弾定数が無い")
        failed += 1
    else:
        print("OK  sentry ammo constants")
    if "function drawSentryBeacon" not in sector_src or "const SENTRY_RGB = \"93,202,122\"" not in sector_src:
        print("FAIL セントリー円の緑ビーコンが無い")
        failed += 1
    else:
        print("OK  sentry green beacon")
    if "function drawTeamCone" not in sector_src or "const TEAM_RGB" not in sector_src or "const TEAM_BURST_COUNT = 10" not in sector_src:
        print("FAIL 迎撃錐／MAP HP／チーム青RGBが無い")
        failed += 1
    else:
        print("OK  team cone and TEAM_RGB")
    if "function drawHq" in sector_src or "function drawHqOsprey" in sector_src:
        print("FAIL 区画MAPに前線指揮所描画が残っている")
        failed += 1
    else:
        print("OK  sector HQ draw removed")
    data_src = (ROOT / "data.js").read_text(encoding="utf-8")
    if "forwardHq:" not in data_src or "前線指揮所" not in data_src:
        print("FAIL data.js に forwardHq（前線指揮所）が無い")
        failed += 1
    else:
        print("OK  forwardHq landmark")
    if "function beginHqRecall" not in html or 'class="map-hq"' not in html:
        print("FAIL ステージMAPの前線指揮所／beginHqRecall が無い")
        failed += 1
    else:
        print("OK  city-map HQ recall")

    if "function acquireShots" not in sector_src or "function drawShots" not in sector_src:
        print("FAIL 射撃演出（acquireShots / drawShots）が無い")
        failed += 1
    else:
        print("OK  sector shots")

    if 'id="map-osprey"' not in html or "function flyOspreyTo" not in html or "function confirmMapSite" not in html:
        print("FAIL MAP オスプレイ展開（map-osprey / flyOspreyTo / confirmMapSite）が無い")
        failed += 1
    else:
        print("OK  map osprey deploy")
    osprey_png = ROOT / "assets" / "map" / "osprey.png"
    if not osprey_png.is_file():
        print("FAIL assets/map/osprey.png が無い")
        failed += 1
    else:
        print("OK  osprey png")
    if "sector-run-clock" not in html or "活動限界のため帰還します" not in html or "function beginLimitedRunExtract" not in html:
        print("FAIL 時限観測（10分カウントダウン／活動限界帰還）が無い")
        failed += 1
    else:
        print("OK  limited run timer")
    if "function confirmNeedItemHtml" not in html or "function confirmDismantleHtml" not in html:
        print("FAIL 確認ダイアログのアイテム画像／所持／分解入手が無い")
        failed += 1
    elif "分解で入手" not in html or "storageDismantlePartQty" not in (ROOT / "game.js").read_text(encoding="utf-8"):
        print("FAIL 分解で入手の表示または storageDismantlePartQty が無い")
        failed += 1
    else:
        print("OK  confirm item facts")

    if "siteTree:" not in (ROOT / "data.js").read_text(encoding="utf-8"):
        print("FAIL data.js に siteTree が無い")
        failed += 1
    else:
        print("OK  siteTree data")

    if "作戦司令部Lv" not in html:
        print("FAIL index.html に 作戦司令部Lv が無い")
        failed += 1
    else:
        print("OK  HQ level label")

    tree_dir = ROOT / "assets" / "tree"
    tree_pngs = sorted(p for p in tree_dir.glob("*.png") if p.is_file())
    if len(tree_pngs) < 20:
        print(f"FAIL assets/tree のアイコンが不足 ({len(tree_pngs)}/20)")
        failed += 1
    else:
        print(f"OK  tree icons ({len(tree_pngs)})")
    tree_icon_ids = re.findall(r'icon:\s*"([a-z0-9-]+)"', (ROOT / "data.js").read_text(encoding="utf-8"))
    for iid in sorted(set(tree_icon_ids)):
        png = tree_dir / f"{iid}.png"
        if not png.is_file():
            print(f"FAIL missing assets/tree/{iid}.png")
            failed += 1

    game = (ROOT / "game.js").read_text(encoding="utf-8")
    for needle, label in (
        ("function sanitizeStateForSave", "sanitizeStateForSave"),
        ("needsWeaponUid", "needsWeaponUid"),
        ('SAVE_KEY = "scp-unknown-save-v1"', "SAVE_KEY"),
        ("seedMaxAttachmentsForVerify", "verify helper kept"),
        ("function allocateSiteNode", "allocateSiteNode"),
        ("function sitePassives", "sitePassives"),
        ("function gearPartFilterId", "gearPartFilterId"),
        ("function gearPartName", "gearPartName"),
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
