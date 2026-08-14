/**
 * SCP-Unknown- サイバースキャン区画マップ。
 * 部屋を手続き生成し、展開チーム（1光点）が円形ライトで地形を解明する。
 * 異常個体は霧の中では見えず、光へ寄ってくる。
 */

/** 決定論的 PRNG（同じ深度なら同じ区画レイアウトになる） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTOR_ROOM_NAMES = [
  "収容室", "観察室", "除染区", "保管庫", "制御室", "隔離房",
  "検体棟", "通信室", "資材庫", "監視所", "実験室", "昇降機",
];

const SECTOR_W = 920;
const SECTOR_H = 430;
const CONTACT_RADIUS = 13;
/** チーム周囲の現在視界。永続解明は部屋単位（この円が部屋に触れたら開く） */
const LIGHT_RADIUS = 80;
/** 進行方向の迎撃錐。解明円とは別に射撃判定に使う */
const TEAM_FOV_DEG = 52;
const TEAM_FOV_RANGE = LIGHT_RADIUS;
const TEAM_BURST_COUNT = 10;
const TEAM_BURST_INTERVAL = 0.07;
const TEAM_SHOT_DAMAGE = 1;
const SENTRY_SHOT_DAMAGE = 2;
const SENTRY_FIRE_INTERVAL = 0.22;
const ENEMY_MAP_HP = 10;
const TEAM_HP_BASE = 80;
const TEAM_HP_PER_MEMBER = 20;
const ENEMY_MELEE_DPS = 12;
const HQ_RESPAWN_SEC = 3.2;
/** 赤がチーム位置を再追尾する間隔。速度は上げず接触頻度だけ稼ぐ */
const RED_SEEK_INTERVAL = 1.2;
const SENTRY_MAX = 2;
const SENTRY_RADIUS = 56;
const SENTRY_HIT = 18;
const SENTRY_AMMO_MAX = 20;
const SENTRY_EMPTY_MS = 10000;
const SENTRY_RGB = "93,202,122";
const SENTRY_SCAN_MS = 3200;
const RESPAWN_DELAY = 5.5;
const BOSS_CONTACT_RADIUS = 18;
/** 収容違反体は展開部隊より速い。逃げ切られると関門が成立しない */
const BOSS_SPEED = 82;
const SHOT_SPEED = 420;
const SHOT_HIT_R = 7;
const RED_DYING_SEC = 0.55;

/** 地点 ID をレイアウト種に混ぜ、同じ深度でも場所ごとに区画が変わるようにする */
function siteSeed(id) {
  let h = 2166136261;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 区画レイアウトを生成する（部屋＋接続） */
function generateSector(depth, siteId) {
  const rand = mulberry32((depth * 7919 + 13 + siteSeed(siteId)) >>> 0);
  const cols = 4;
  const rows = 3;
  const cellW = SECTOR_W / cols;
  const cellH = SECTOR_H / rows;
  const rooms = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 一部のセルを空白にして区画に変化をつける（最低 8 部屋は確保）
      if (rand() < 0.16 && rooms.length >= 8) continue;
      const padX = 22 + rand() * 10;
      const padY = 20 + rand() * 8;
      const w = cellW - padX * 2;
      const h = cellH - padY * 2;
      const x = c * cellW + padX;
      const y = r * cellH + padY;
      rooms.push({
        id: rooms.length,
        col: c,
        row: r,
        x, y, w, h,
        cx: x + w / 2,
        cy: y + h / 2,
        name: SECTOR_ROOM_NAMES[Math.floor(rand() * SECTOR_ROOM_NAMES.length)],
        code: `${String.fromCharCode(65 + r)}-${String(c + 1).padStart(2, "0")}`,
      });
    }
  }

  const corridors = [];
  const adjacency = rooms.map(() => []);
  for (const a of rooms) {
    for (const b of rooms) {
      if (b.id <= a.id) continue;
      const sameRow = a.row === b.row && Math.abs(a.col - b.col) === 1;
      const sameCol = a.col === b.col && Math.abs(a.row - b.row) === 1;
      if (!sameRow && !sameCol) continue;
      corridors.push({ a: a.id, b: b.id });
      adjacency[a.id].push(b.id);
      adjacency[b.id].push(a.id);
    }
  }

  // 孤立部屋は最寄りの部屋へ強制接続する
  for (const room of rooms) {
    if (adjacency[room.id].length > 0) continue;
    let nearest = null;
    let best = Infinity;
    for (const other of rooms) {
      if (other.id === room.id) continue;
      const d = Math.hypot(other.cx - room.cx, other.cy - room.cy);
      if (d < best) { best = d; nearest = other; }
    }
    if (nearest) {
      corridors.push({ a: room.id, b: nearest.id });
      adjacency[room.id].push(nearest.id);
      adjacency[nearest.id].push(room.id);
    }
  }

  return { depth, rooms, corridors, adjacency, width: SECTOR_W, height: SECTOR_H };
}

/** 部屋 a → b の L 字ウェイポイント */
function elbowWaypoints(a, b) {
  return [{ x: b.cx, y: a.cy }, { x: b.cx, y: b.cy }];
}

/** 幅優先探索で部屋間の経路を求める */
function findRoomPath(sector, fromId, toId) {
  if (fromId === toId) return [];
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === toId) break;
    for (const next of sector.adjacency[cur]) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  if (!prev.has(toId)) return [];
  const path = [];
  let node = toId;
  while (node !== null && node !== fromId) {
    path.unshift(node);
    node = prev.get(node);
  }
  return path;
}

function teamAgent(sim) {
  return sim.blues[0] || null;
}

function distPointToRoom(x, y, room) {
  const nx = Math.max(room.x, Math.min(x, room.x + room.w));
  const ny = Math.max(room.y, Math.min(y, room.y + room.h));
  return Math.hypot(x - nx, y - ny);
}

function isPointLit(sim, x, y) {
  const team = teamAgent(sim);
  if (!team) return false;
  return Math.hypot(x - team.x, y - team.y) <= LIGHT_RADIUS;
}

function isRoomRevealed(sim, roomId) {
  return sim.revealed instanceof Set && sim.revealed.has(roomId);
}

/** 円が触れた部屋を解明済みにする。新規があれば true */
function revealRoomsAround(sim, state) {
  const team = teamAgent(sim);
  if (!team) return false;
  let added = false;
  for (const room of sim.sector.rooms) {
    if (sim.revealed.has(room.id)) continue;
    if (distPointToRoom(team.x, team.y, room) > LIGHT_RADIUS) continue;
    sim.revealed.add(room.id);
    added = true;
  }
  if (added) state.revealedRooms = [...sim.revealed];
  return added;
}

function createAgent(sector, side, label, rand) {
  const room = sector.rooms[Math.floor(rand() * sector.rooms.length)];
  return {
    side,
    label,
    roomId: room.id,
    x: room.cx + (rand() - 0.5) * 20,
    y: room.cy + (rand() - 0.5) * 16,
    waypoints: [],
    speed: side === "blue" ? 46 + rand() * 22 : 34 + rand() * 20,
    trail: [],
    dead: false,
    dying: false,
    dyingAge: 0,
    incoming: false,
    respawnAt: 0,
    pulse: rand() * Math.PI * 2,
    facing: 0,
    hp: side === "red" ? ENEMY_MAP_HP : 0,
    hpMax: side === "red" ? ENEMY_MAP_HP : 0,
    fireCd: 0,
    burstLeft: 0,
    aimTarget: null,
  };
}

/**
 * 区画シミュレーションを作る。
 * @param {object} state ゲーム状態（部隊名・報酬付与に使う）
 * @param {object} floorData 現在フロア定義
 */
function createSectorSim(state, floorData) {
  const siteId = state.mapSite || GAME_DATA.defaultMapSite;
  const sector = generateSector(floorData.depth, siteId);
  const rand = mulberry32((floorData.depth * 104729 + 7 + siteSeed(siteId)) >>> 0);

  const squad = getSquadUnits(state);
  const opAgent = createAgent(sector, "blue", "展開チーム", rand);
  opAgent.isOperator = true;
  opAgent.hpMax = TEAM_HP_BASE + squad.length * TEAM_HP_PER_MEMBER;
  opAgent.hp = opAgent.hpMax;
  const blues = [opAgent];
  const hqRoom = sector.rooms[opAgent.roomId] || sector.rooms[0];

  const redCount = Math.min(6, 2 + Math.floor(floorData.depth / 8) + floorData.enemies.length);
  const reds = [];
  for (let i = 0; i < redCount; i++) {
    const enemy = floorData.enemies[i % floorData.enemies.length];
    const cat = GAME_DATA.catalog[enemy.catalogId];
    reds.push(createAgent(sector, "red", cat ? cat.scp : "異常個体", rand));
  }

  const revealed = new Set(
    (Array.isArray(state.revealedRooms) ? state.revealedRooms : [])
      .filter((id) => sector.rooms.some((r) => r.id === id))
  );
  revealed.add(opAgent.roomId);
  for (const s of Array.isArray(state.sentries) ? state.sentries : []) {
    const room = roomContaining(sector, s.x, s.y);
    if (room) revealed.add(room.id);
  }
  state.revealedRooms = [...revealed];

  return {
    sector,
    depth: floorData.depth,
    floorData,
    mapSite: siteId,
    squadKey: `op|${(state.squad || []).join(",")}`,
    squadSize: 1 + squad.length,
    blues,
    reds,
    revealed,
    boss: null,
    flashes: [],
    shots: [],
    events: [],
    time: 0,
    rand,
    contacts: 0,
    sentries: Array.isArray(state.sentries) ? state.sentries : [],
    hq: { x: hqRoom.cx, y: hqRoom.cy, roomId: hqRoom.id },
    teamDown: false,
    respawnAt: 0,
  };
}

/** 掃討率満了で収容違反体を出現させる。展開部隊から最も遠い部屋に置く */
function spawnBoss(sim) {
  let room = sim.sector.rooms[0];
  let bestDist = -1;
  for (const candidate of sim.sector.rooms) {
    let nearest = Infinity;
    for (const b of sim.blues) {
      nearest = Math.min(nearest, Math.hypot(candidate.cx - b.x, candidate.cy - b.y));
    }
    if (nearest > bestDist) { bestDist = nearest; room = candidate; }
  }
  const enemy = sim.floorData.enemies[0];
  const cat = enemy ? GAME_DATA.catalog[enemy.catalogId] : null;
  sim.boss = {
    label: cat ? `${cat.scp} 収容違反体` : "収容違反体",
    x: room.cx,
    y: room.cy,
    trail: [],
    pulse: 0,
  };
}

/**
 * 収容違反体は部屋や通路を無視して最寄りの展開部隊を直進追尾する。
 * @returns {object|null} 接触した青エージェント
 */
function updateBoss(sim, dt) {
  const boss = sim.boss;
  let target = null;
  let best = Infinity;
  for (const b of sim.blues) {
    const d = Math.hypot(b.x - boss.x, b.y - boss.y);
    if (d < best) { best = d; target = b; }
  }
  if (!target) return null;

  const step = BOSS_SPEED * dt;
  if (best > step) {
    boss.x += ((target.x - boss.x) / best) * step;
    boss.y += ((target.y - boss.y) / best) * step;
  } else {
    boss.x = target.x;
    boss.y = target.y;
  }

  boss.trail.push({ x: boss.x, y: boss.y });
  if (boss.trail.length > 26) boss.trail.shift();
  boss.pulse += dt * 4;

  return Math.hypot(target.x - boss.x, target.y - boss.y) <= BOSS_CONTACT_RADIUS ? target : null;
}

function assignNewTarget(sim, agent) {
  const sector = sim.sector;
  let targetId = agent.roomId;
  for (let tries = 0; tries < 6 && targetId === agent.roomId; tries++) {
    targetId = Math.floor(sim.rand() * sector.rooms.length);
  }
  const path = findRoomPath(sector, agent.roomId, targetId);
  const waypoints = [];
  let cur = sector.rooms[agent.roomId];
  for (const id of path) {
    const next = sector.rooms[id];
    waypoints.push(...elbowWaypoints(cur, next));
    cur = next;
  }
  // 部屋内をうろつく微小オフセット
  waypoints.push({
    x: cur.cx + (sim.rand() - 0.5) * (cur.w * 0.55),
    y: cur.cy + (sim.rand() - 0.5) * (cur.h * 0.55),
  });
  agent.waypoints = waypoints;
  agent.roomId = targetId;
}

/** 異常個体は光（チーム）へ向かう。速度は据え置き、接触機会だけ増やす */
function assignSeekTeam(sim, agent, team) {
  const sector = sim.sector;
  const liveRoom = roomContaining(sector, team.x, team.y);
  const targetId = liveRoom ? liveRoom.id : team.roomId;
  const here = roomContaining(sector, agent.x, agent.y);
  const fromId = here ? here.id : agent.roomId;
  const path = findRoomPath(sector, fromId, targetId);
  const waypoints = [];
  let cur = sector.rooms[fromId] || sector.rooms[0];
  for (const id of path) {
    const next = sector.rooms[id];
    waypoints.push(...elbowWaypoints(cur, next));
    cur = next;
  }
  waypoints.push({ x: team.x, y: team.y });
  agent.waypoints = waypoints;
  agent.roomId = targetId;
}

function updateAgent(sim, agent, dt) {
  if (agent.waypoints.length === 0) {
    if (agent.side === "red") return;
    assignNewTarget(sim, agent);
    return;
  }
  const wp = agent.waypoints[0];
  const dx = wp.x - agent.x;
  const dy = wp.y - agent.y;
  const dist = Math.hypot(dx, dy);
  const step = agent.speed * dt;

  if (dist > 0.4) agent.facing = Math.atan2(dy, dx);

  if (dist <= step) {
    agent.x = wp.x;
    agent.y = wp.y;
    agent.waypoints.shift();
  } else {
    agent.x += (dx / dist) * step;
    agent.y += (dy / dist) * step;
  }

  agent.trail.push({ x: agent.x, y: agent.y });
  if (agent.trail.length > 18) agent.trail.shift();
  agent.pulse += dt * 3;
}

/**
 * 1 フレーム進める。接触が起きたら state に報酬を加算しイベントを積む。
 * @returns {{changed: boolean, breach: object|null}} changed はセーブ要否、breach はボス戦の結果
 */
function updateSectorSim(sim, state, dt) {
  const mult = sectorSpeedMult(state);
  dt *= mult;
  sim.time += dt;
  let stateChanged = false;
  let breach = null;
  if (expireEmptySentries(sim)) {
    sim.events.push("セントリーガンが弾切れで撤去された");
    stateChanged = true;
  }

  for (const b of sim.blues) {
    if (b.dead) continue;
    updateAgent(sim, b, dt);
  }
  if (revealRoomsAround(sim, state)) stateChanged = true;

  const team = teamAgent(sim);
  tickFireCds(sim, dt);
  if (!sim.boss) {
    if (applyMelee(sim, dt)) stateChanged = true;
    if (beginTeamWipeIfNeeded(sim)) stateChanged = true;
    if (respawnTeamIfReady(sim)) stateChanged = true;
  }
  if (!sim.boss) {
    for (const r of sim.reds) {
      if (r.dead) {
        if (sim.time >= r.respawnAt) {
          const room = sim.sector.rooms[Math.floor(sim.rand() * sim.sector.rooms.length)];
          r.dead = false;
          r.dying = false;
          r.dyingAge = 0;
          r.incoming = false;
          r.hp = r.hpMax || ENEMY_MAP_HP;
          r.roomId = room.id;
          r.x = room.cx;
          r.y = room.cy;
          r.trail = [];
          r.waypoints = [];
          r.seekAt = 0;
        }
        continue;
      }
      if (r.dying) {
        r.dyingAge += dt;
        if (r.dyingAge >= RED_DYING_SEC) {
          r.dead = true;
          r.dying = false;
          r.incoming = false;
        }
        continue;
      }
      if (team && !team.dead && (sim.time >= (r.seekAt || 0) || r.waypoints.length === 0)) {
        assignSeekTeam(sim, r, team);
        r.seekAt = sim.time + RED_SEEK_INTERVAL;
      }
      updateAgent(sim, r, dt);
    }
  }

  sim.sentries = Array.isArray(state.sentries) ? state.sentries : [];

  if (sim.boss) {
    const hit = updateBoss(sim, dt);
    for (const f of sim.flashes) f.age += dt;
    sim.flashes = sim.flashes.filter((f) => f.age < 0.8);
    if (hit) {
      sim.flashes.push({ x: hit.x, y: hit.y, age: 0, big: true });
      sim.events.push(`[${sim.sector.rooms[hit.roomId]?.code || "??"}] 収容違反体と接触 — 交戦開始`);
    }
    return { changed: stateChanged, breach: null, bossHit: !!hit };
  }

  if (updateShots(sim, state, dt)) stateChanged = true;
  if (acquireShots(sim, state)) stateChanged = true;

  for (const f of sim.flashes) f.age += dt;
  sim.flashes = sim.flashes.filter((f) => f.age < 0.8);
  if (sim.events.length > 40) sim.events = sim.events.slice(-40);

  return { changed: stateChanged, breach, bossHit: false };
}

function redIsBusy(r) {
  return !r || r.dead || r.dying;
}

function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function inTeamCone(team, x, y) {
  if (!team) return false;
  const dx = x - team.x;
  const dy = y - team.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2 || dist > TEAM_FOV_RANGE) return false;
  const half = (TEAM_FOV_DEG * Math.PI) / 360;
  return Math.abs(angleDelta(Math.atan2(dy, dx), team.facing || 0)) <= half;
}

function nearestRedInCone(sim, team) {
  let best = null;
  let bestD = Infinity;
  for (const r of sim.reds) {
    if (redIsBusy(r)) continue;
    if (!inTeamCone(team, r.x, r.y)) continue;
    const d = Math.hypot(r.x - team.x, r.y - team.y);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

function aimTeamTarget(sim, team) {
  const cur = team.aimTarget;
  if (cur && !redIsBusy(cur) && Math.hypot(cur.x - team.x, cur.y - team.y) <= TEAM_FOV_RANGE) {
    return cur;
  }
  const next = nearestRedInCone(sim, team);
  team.aimTarget = next;
  return next;
}

function tickFireCds(sim, dt) {
  const team = teamAgent(sim);
  if (team) team.fireCd = Math.max(0, (team.fireCd || 0) - dt);
  for (const s of sim.sentries || []) {
    s._fireCd = Math.max(0, (s._fireCd || 0) - dt);
  }
}

function applyMelee(sim, dt) {
  const team = teamAgent(sim);
  if (!team || team.dead || sim.teamDown) return false;
  let hit = false;
  for (const r of sim.reds) {
    if (redIsBusy(r)) continue;
    if (Math.hypot(r.x - team.x, r.y - team.y) > CONTACT_RADIUS) continue;
    team.hp = Math.max(0, (team.hp || 0) - ENEMY_MELEE_DPS * dt);
    hit = true;
  }
  return hit;
}

function beginTeamWipeIfNeeded(sim) {
  const team = teamAgent(sim);
  if (!team || sim.teamDown || team.dead) return false;
  if ((team.hp || 0) > 0) return false;
  team.dead = true;
  team.hp = 0;
  team.aimTarget = null;
  team.burstLeft = 0;
  sim.teamDown = true;
  sim.respawnAt = sim.time + HQ_RESPAWN_SEC;
  const hq = sim.hq;
  const roomName = hq && sim.sector.rooms[hq.roomId] ? sim.sector.rooms[hq.roomId].code : "HQ";
  sim.events.push(`[${roomName}] 展開チームが撤退 — 前線指揮所へ再展開`);
  return true;
}

function respawnTeamIfReady(sim) {
  const team = teamAgent(sim);
  if (!sim.teamDown || !team || sim.time < sim.respawnAt) return false;
  const hq = sim.hq || { x: team.x, y: team.y, roomId: team.roomId };
  team.dead = false;
  team.hp = team.hpMax || TEAM_HP_BASE;
  team.x = hq.x;
  team.y = hq.y;
  team.roomId = hq.roomId;
  team.waypoints = [];
  team.trail = [];
  team.aimTarget = null;
  team.burstLeft = 0;
  sim.teamDown = false;
  sim.events.push("オスプレイが前線指揮所に展開 — 巡回を再開");
  return true;
}

function fireShot(sim, fromX, fromY, target, kind, sentry) {
  if (!sim.shots) sim.shots = [];
  sim.shots.push({
    x: fromX,
    y: fromY,
    target,
    kind,
    sentry: sentry || null,
    rgb: kind === "sentry" ? SENTRY_RGB : "90,150,200",
    tail: [{ x: fromX, y: fromY }],
  });
}

/** セントリーは円内、チームは迎撃錐内の敵へ連射。 */
function acquireShots(sim, state) {
  let fired = false;
  for (const r of sim.reds) {
    if (redIsBusy(r)) continue;
    for (const s of sim.sentries || []) {
      if ((s.ammo || 0) <= 0) continue;
      if ((s._fireCd || 0) > 0) continue;
      if (Math.hypot(r.x - s.x, r.y - s.y) > sentryRadiusOf(state)) continue;
      fireShot(sim, s.x, s.y, r, "sentry", s);
      const save = sitePassives(state).sentrySave || 0;
      if (save <= 0 || Math.random() >= save) {
        s.ammo = Math.max(0, (typeof s.ammo === "number" ? s.ammo : sentryAmmoMaxOf(state)) - 1);
      }
      if (s.ammo <= 0) s.emptyAtMs = Date.now();
      s._fireCd = SENTRY_FIRE_INTERVAL;
      fired = true;
      break;
    }
  }

  const team = teamAgent(sim);
  if (!team || team.dead || sim.teamDown) return fired;
  const target = aimTeamTarget(sim, team);
  if (!target) {
    team.burstLeft = 0;
    return fired;
  }
  team.facing = Math.atan2(target.y - team.y, target.x - team.x);
  if ((team.burstLeft || 0) <= 0 && (team.fireCd || 0) <= 0) {
    team.burstLeft = TEAM_BURST_COUNT;
  }
  if ((team.burstLeft || 0) > 0 && (team.fireCd || 0) <= 0) {
    fireShot(sim, team.x, team.y, target, "team", null);
    team.burstLeft -= 1;
    team.fireCd = TEAM_BURST_INTERVAL;
    fired = true;
  }
  return fired;
}

function applyShotHit(sim, state, shot) {
  const r = shot.target;
  if (!r || r.dead || r.dying) return false;
  const dmg = shot.kind === "sentry" ? SENTRY_SHOT_DAMAGE : TEAM_SHOT_DAMAGE;
  r.hp = Math.max(0, (typeof r.hp === "number" ? r.hp : ENEMY_MAP_HP) - dmg);
  if (r.hp > 0) return false;
  r.dying = true;
  r.dyingAge = 0;
  r.waypoints = [];
  r.respawnAt = sim.time + RED_DYING_SEC + RESPAWN_DELAY;
  sim.contacts++;
  sim.flashes.push({ x: r.x, y: r.y, age: 0 });
  const reward = runSkirmish(state, sim.depth);
  const roomName = sim.sector.rooms[r.roomId]?.code || "??";
  const who = shot.kind === "sentry" ? "セントリーガン" : (teamAgent(sim)?.label || "展開チーム");
  if (reward) {
    sim.events.push(
      `[${roomName}] ${who} が ${r.label} を撃破 — XP +${reward.xp} / 予算 +${reward.budget}` +
      (reward.item ? ` / ${reward.item} 回収` : "") +
      ` (掃討 ${reward.kills}/${reward.need})`
    );
  }
  return true;
}

function updateShots(sim, state, dt) {
  if (!sim.shots) sim.shots = [];
  let changed = false;
  const next = [];
  for (const shot of sim.shots) {
    const t = shot.target;
    if (!t || t.dead || t.dying) continue;
    const dx = t.x - shot.x;
    const dy = t.y - shot.y;
    const dist = Math.hypot(dx, dy);
    const step = SHOT_SPEED * dt;
    if (dist <= SHOT_HIT_R || dist <= step) {
      if (applyShotHit(sim, state, shot)) changed = true;
      continue;
    }
    shot.x += (dx / dist) * step;
    shot.y += (dy / dist) * step;
    shot.tail.push({ x: shot.x, y: shot.y });
    if (shot.tail.length > 6) shot.tail.shift();
    next.push(shot);
  }
  sim.shots = next;
  return changed;
}

function drawShots(ctx, sim) {
  for (const shot of sim.shots || []) {
    const rgb = shot.rgb || "196,163,74";
    if (shot.tail.length > 1) {
      ctx.strokeStyle = `rgba(${rgb},0.85)`;
      ctx.lineWidth = shot.kind === "sentry" ? 2.2 : 1.8;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(shot.tail[0].x, shot.tail[0].y);
      for (let i = 1; i < shot.tail.length; i++) ctx.lineTo(shot.tail[i].x, shot.tail[i].y);
      ctx.stroke();
    }
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.arc(shot.x, shot.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,230,0.9)";
    ctx.beginPath();
    ctx.arc(shot.x, shot.y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCorridor(ctx, a, b, live) {
  const pts = [{ x: a.cx, y: a.cy }, ...elbowWaypoints(a, b)];
  ctx.strokeStyle = live ? "rgba(122,138,88,0.28)" : "rgba(122,138,88,0.12)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.strokeStyle = live ? "rgba(122,138,88,0.55)" : "rgba(122,138,88,0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawRoomShape(ctx, room, live) {
  ctx.fillStyle = live ? "rgba(62,92,128,0.22)" : "rgba(62,92,128,0.08)";
  ctx.fillRect(room.x, room.y, room.w, room.h);
  ctx.strokeStyle = live ? "rgba(160,190,220,0.8)" : "rgba(62,92,128,0.45)";
  ctx.lineWidth = 1.2;
  ctx.strokeRect(room.x, room.y, room.w, room.h);

  const t = 9;
  ctx.strokeStyle = live ? "rgba(196,163,74,0.75)" : "rgba(196,163,74,0.35)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(room.x, room.y + t); ctx.lineTo(room.x, room.y); ctx.lineTo(room.x + t, room.y);
  ctx.moveTo(room.x + room.w - t, room.y); ctx.lineTo(room.x + room.w, room.y); ctx.lineTo(room.x + room.w, room.y + t);
  ctx.moveTo(room.x, room.y + room.h - t); ctx.lineTo(room.x, room.y + room.h); ctx.lineTo(room.x + t, room.y + room.h);
  ctx.moveTo(room.x + room.w - t, room.y + room.h); ctx.lineTo(room.x + room.w, room.y + room.h); ctx.lineTo(room.x + room.w, room.y + room.h - t);
  ctx.stroke();

  ctx.fillStyle = live ? "rgba(180,190,185,0.9)" : "rgba(180,190,185,0.45)";
  ctx.font = "10px Consolas, monospace";
  ctx.fillText(`${room.code} ${room.name}`, room.x + 6, room.y + 14);
}

function drawTeamLight(ctx, team) {
  if (!team) return;
  const glow = ctx.createRadialGradient(team.x, team.y, 8, team.x, team.y, LIGHT_RADIUS);
  glow.addColorStop(0, "rgba(200,214,230,0.22)");
  glow.addColorStop(0.55, "rgba(90,130,170,0.10)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(team.x, team.y, LIGHT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(196,163,74,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(team.x, team.y, LIGHT_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
}

function drawTeamCone(ctx, team) {
  if (!team || team.dead) return;
  const facing = team.facing || 0;
  const half = (TEAM_FOV_DEG * Math.PI) / 360;
  const r = TEAM_FOV_RANGE;
  const x1 = team.x + Math.cos(facing - half) * r;
  const y1 = team.y + Math.sin(facing - half) * r;
  const x2 = team.x + Math.cos(facing + half) * r;
  const y2 = team.y + Math.sin(facing + half) * r;
  ctx.beginPath();
  ctx.moveTo(team.x, team.y);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.fillStyle = "rgba(196,163,74,0.12)";
  ctx.fill();
  ctx.strokeStyle = "rgba(196,163,74,0.55)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawHpBar(ctx, x, y, hp, hpMax, rgb) {
  if (!(hpMax > 0)) return;
  const w = 18;
  const h = 3;
  const y0 = y + 11;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(x - w / 2, y0, w, h);
  ctx.fillStyle = `rgb(${rgb})`;
  ctx.fillRect(x - w / 2, y0, w * Math.max(0, Math.min(1, hp / hpMax)), h);
}

function drawHq(ctx, sim) {
  const hq = sim.hq;
  if (!hq) return;
  if (!isRoomRevealed(sim, hq.roomId)) return;
  ctx.fillStyle = "rgba(90,150,200,0.28)";
  ctx.strokeStyle = "rgba(140,190,220,0.9)";
  ctx.lineWidth = 1.4;
  ctx.fillRect(hq.x - 9, hq.y - 7, 18, 14);
  ctx.strokeRect(hq.x - 9, hq.y - 7, 18, 14);
  ctx.fillStyle = "rgba(200,220,240,0.92)";
  ctx.font = "9px Consolas, monospace";
  ctx.fillText("前線指揮所", hq.x + 12, hq.y + 3);
}

let sectorOspreyImg = null;
function sectorOspreyImage() {
  if (typeof Image === "undefined") return null;
  if (sectorOspreyImg) return sectorOspreyImg;
  sectorOspreyImg = new Image();
  sectorOspreyImg.src = "assets/map/osprey.png";
  return sectorOspreyImg;
}

function drawHqOsprey(ctx, sim) {
  if (!sim.teamDown || !sim.hq) return;
  const x = sim.hq.x;
  const y = sim.hq.y + Math.sin(sim.time * 3) * 3;
  const img = sectorOspreyImage();
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, x - 18, y - 22, 36, 28);
    return;
  }
  ctx.fillStyle = "rgba(196,163,74,0.85)";
  ctx.beginPath();
  ctx.moveTo(x - 10, y + 6);
  ctx.lineTo(x, y - 8);
  ctx.lineTo(x + 10, y + 6);
  ctx.closePath();
  ctx.fill();
}

/** 未解明は黒、解明済みは残像、円内だけ明るくする */
function drawSector(ctx, sim) {
  const { sector } = sim;
  const w = sector.width;
  const h = sector.height;
  const team = teamAgent(sim);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#030406";
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.beginPath();
  for (const room of sector.rooms) {
    if (!isRoomRevealed(sim, room.id)) continue;
    ctx.rect(room.x, room.y, room.w, room.h);
  }
  ctx.clip();
  ctx.strokeStyle = "rgba(62,92,128,0.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 26) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0; y <= h; y += 26) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.restore();

  for (const c of sector.corridors) {
    if (!isRoomRevealed(sim, c.a) && !isRoomRevealed(sim, c.b)) continue;
    const a = sector.rooms[c.a];
    const b = sector.rooms[c.b];
    const live = (team && distPointToRoom(team.x, team.y, a) <= LIGHT_RADIUS)
      || (team && distPointToRoom(team.x, team.y, b) <= LIGHT_RADIUS);
    drawCorridor(ctx, a, b, live);
  }

  for (const room of sector.rooms) {
    if (!isRoomRevealed(sim, room.id)) continue;
    const live = team ? distPointToRoom(team.x, team.y, room) <= LIGHT_RADIUS : false;
    drawRoomShape(ctx, room, live);
  }

  drawHq(ctx, sim);
  if (team && !team.dead) {
    drawTeamLight(ctx, team);
    drawTeamCone(ctx, team);
  }

  const visibleReds = sim.reds.filter((r) => !r.dead && (r.dying || isPointLit(sim, r.x, r.y)));
  drawAgents(ctx, visibleReds, "176,48,40");
  drawAgents(ctx, sim.blues, "90,150,200");
  drawHqOsprey(ctx, sim);
  drawShots(ctx, sim);

  const placed = (sim.sentries || []).filter((s) => {
    const room = roomContaining(sector, s.x, s.y);
    return room && isRoomRevealed(sim, room.id);
  });
  drawSentries(ctx, placed, typeof sentryPreview !== "undefined" ? sentryPreview : null, sentryRadiusOf(typeof state !== "undefined" ? state : null));
  if (sim.boss) drawBoss(ctx, sim.boss);

  for (const f of sim.flashes) {
    const flashRoom = roomContaining(sector, f.x, f.y);
    if (!isPointLit(sim, f.x, f.y) && !(flashRoom && isRoomRevealed(sim, flashRoom.id))) continue;
    const p = f.age / 0.8;
    const scale = f.big ? 3 : 1;
    ctx.strokeStyle = `rgba(255,214,120,${1 - p})`;
    ctx.lineWidth = f.big ? 3 : 2;
    ctx.beginPath();
    ctx.arc(f.x, f.y, (6 + p * 26) * scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(0,0,0,0.16)";
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
}

function roomContaining(sector, x, y) {
  return sector.rooms.find((r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) || null;
}

/** 弾切れから 10 秒経過した砲台を外す。sim.sentries は state.sentries と同一配列 */
function expireEmptySentries(sim) {
  const now = Date.now();
  let removed = false;
  const list = sim.sentries || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (typeof s.ammo !== "number") s.ammo = sentryAmmoMaxOf(typeof state !== "undefined" ? state : null);
    if (s.ammo > 0) {
      delete s.emptyAtMs;
      continue;
    }
    if (typeof s.emptyAtMs !== "number") s.emptyAtMs = now;
    if (now - s.emptyAtMs >= SENTRY_EMPTY_MS) {
      list.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

function sentryIndexAt(sentries, x, y) {
  let best = -1;
  let bestD = SENTRY_HIT;
  (sentries || []).forEach((s, i) => {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function drawSentries(ctx, sentries, preview, radius) {
  const rad = radius || SENTRY_RADIUS;
  const nowMs = Date.now();
  const items = sentries.map((s) => ({ s, ghost: false }));
  if (preview) items.push({ s: preview, ghost: true });
  for (const { s, ghost } of items) {
    const empty = !ghost && (s.ammo || 0) <= 0;
    const rgb = empty ? "176,48,40" : SENTRY_RGB;
    const alpha = ghost ? 0.45 : 0.7;
    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
    ctx.lineWidth = ghost ? 1 : 1.4;
    ctx.setLineDash(ghost ? [5, 4] : [3, 5]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = `rgba(${rgb},${ghost ? 0.08 : 0.12})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
    ctx.fill();

    if (!empty) drawSentryBeacon(ctx, s.x, s.y, rad, rgb, nowMs, ghost);

    ctx.fillStyle = ghost ? `rgba(${SENTRY_RGB},0.55)` : (empty ? "#b03028" : "#5dca7a");
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - 7);
    ctx.lineTo(s.x + 6, s.y + 5);
    ctx.lineTo(s.x - 6, s.y + 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(8,10,12,0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** 中心から外周へゆっくり広がる索敵ビーコン。砲台ごとに位相をずらす */
function drawSentryBeacon(ctx, x, y, rad, rgb, nowMs, ghost) {
  const phase = ((nowMs / SENTRY_SCAN_MS) + x * 0.013 + y * 0.017) % 1;
  const scanR = phase * rad;
  if (scanR < 1.5) return;
  const fade = 1 - phase;
  const inner = Math.max(0, scanR - 12);
  const glow = ctx.createRadialGradient(x, y, inner, x, y, scanR);
  glow.addColorStop(0, `rgba(${rgb},0)`);
  glow.addColorStop(0.55, `rgba(${rgb},${(ghost ? 0.07 : 0.14) * fade})`);
  glow.addColorStop(1, `rgba(${rgb},${(ghost ? 0.28 : 0.5) * fade})`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, scanR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${rgb},${(ghost ? 0.4 : 0.9) * fade})`;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, scanR, 0, Math.PI * 2);
  ctx.stroke();
}

/** 収容違反体は通常の赤点より大きく、脈動する二重リングで描く */
function drawBoss(ctx, boss) {
  const rgb = "176,48,40";

  for (let i = 0; i < boss.trail.length; i++) {
    const p = boss.trail[i];
    ctx.fillStyle = `rgba(${rgb},${(i / boss.trail.length) * 0.4})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const glow = ctx.createRadialGradient(boss.x, boss.y, 0, boss.x, boss.y, 34);
  glow.addColorStop(0, `rgba(${rgb},0.6)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(boss.x, boss.y, 34, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `rgb(${rgb})`;
  ctx.beginPath();
  ctx.arc(boss.x, boss.y, 7 + Math.sin(boss.pulse) * 1.6, 0, Math.PI * 2);
  ctx.fill();

  for (let ring = 0; ring < 2; ring++) {
    const phase = (boss.pulse * 0.5 + ring * 0.5) % 1;
    ctx.strokeStyle = `rgba(${rgb},${0.7 - phase * 0.7})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, 12 + phase * 24, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,190,190,0.95)";
  ctx.font = "bold 11px Consolas, monospace";
  ctx.fillText(boss.label, boss.x + 14, boss.y - 12);
}

function drawAgents(ctx, agents, rgb) {
  for (const a of agents) {
    if (a.dead) continue;
    const dyingT = a.dying ? Math.min(1, a.dyingAge / RED_DYING_SEC) : 0;
    const fade = 1 - dyingT * 0.82;
    const sizeMul = (a.isOperator ? 1.35 : 1) * (1 + dyingT * 0.7);
    const agentRgb = a.isOperator ? "196,163,74" : rgb;

    for (let i = 0; i < a.trail.length; i++) {
      const p = a.trail[i];
      const alpha = (i / a.trail.length) * 0.35 * fade;
      ctx.fillStyle = `rgba(${agentRgb},${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8 * sizeMul, 0, Math.PI * 2);
      ctx.fill();
    }

    const glowR = 14 * sizeMul;
    const glow = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, glowR);
    glow.addColorStop(0, `rgba(${agentRgb},${0.55 * fade})`);
    glow.addColorStop(1, `rgba(${agentRgb},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(a.x, a.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    const r = (3.2 + Math.sin(a.pulse) * 0.7) * sizeMul;
    ctx.fillStyle = `rgba(${agentRgb},${fade})`;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${agentRgb},${0.5 * fade})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 8 * sizeMul, 0, Math.PI * 2);
    ctx.stroke();

    if (!a.dying) drawHpBar(ctx, a.x, a.y, a.hp, a.hpMax, agentRgb);
  }
}
