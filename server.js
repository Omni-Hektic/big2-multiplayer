const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { randomInt, randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || "*" } });
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, service: "big2-quick-match" }));

const SUITS = ["D", "C", "H", "S"]; // low to high
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const rankValue = r => RANKS.indexOf(r);
const suitValue = s => SUITS.indexOf(s);
const cardKey = c => `${c.rank}${c.suit}`;
const cardValue = c => rankValue(c.rank) * 4 + suitValue(c.suit);
function deck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit, id: `${rank}${suit}` })));
}
function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
function sortHand(cards) { return cards.sort((a,b) => cardValue(a)-cardValue(b)); }
function combo(cards) {
  if (!Array.isArray(cards) || ![1,2,3,5].includes(cards.length)) return null;
  const sorted = [...cards].sort((a,b) => cardValue(a)-cardValue(b));
  const ranks = sorted.map(c => rankValue(c.rank));
  const suits = sorted.map(c => suitValue(c.suit));
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r,n]) => ({ r: Number(r), n })).sort((a,b) => b.n-a.n || b.r-a.r);
  const highest = Math.max(...sorted.map(cardValue));
  if (cards.length === 1) return { size:1, type:1, power:[highest] };
  if (cards.length === 2 && groups[0].n === 2) return { size:2, type:1, power:[groups[0].r, highest] };
  if (cards.length === 3 && groups[0].n === 3) return { size:3, type:1, power:[groups[0].r, highest] };
  if (cards.length !== 5) return null;
  const flush = suits.every(s => s === suits[0]);
  // This variant treats A-2-3-4-5 as the lowest straight; 2-3-4-5-6 is next.
  const unique = [...new Set(ranks)].sort((a,b)=>a-b);
  let straightHigh = null;
  if (unique.length === 5) {
    if (unique.join(",") === [0,1,2,11,12].join(",")) straightHigh = 2; // A,2,3,4,5 represented low
    else if (unique.every((v,i)=>i===0 || v===unique[i-1]+1)) straightHigh = unique[4];
  }
  const isStraight = straightHigh !== null;
  if (isStraight && flush) {
    const highSuit = Math.max(...suits);
    return { size:5, type:5, power:[straightHigh, highSuit] };
  }
  if (groups[0].n === 4) return { size:5, type:4, power:[groups[0].r, groups[1].r] };
  if (groups[0].n === 3 && groups[1].n === 2) return { size:5, type:3, power:[groups[0].r, groups[1].r] };
  if (flush) return { size:5, type:2, power:[...sorted.map(cardValue).sort((a,b)=>b-a)] };
  if (isStraight) return { size:5, type:1, power:[straightHigh, Math.max(...suits)] };
  return null;
}
function compareCombo(a,b) {
  if (!a || !b || a.size !== b.size) return false;
  if (a.size === 5 && a.type !== b.type) return a.type > b.type;
  for (let i=0;i<Math.max(a.power.length,b.power.length);i++) {
    const av = a.power[i] ?? 0, bv = b.power[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}
function validPlay(cards, lastPlay, mustContainThreeD) {
  const c = combo(cards);
  if (!c) return { ok:false, error:"That combination is not valid." };
  if (mustContainThreeD && !cards.some(x=>x.rank==="3" && x.suit==="D"))
    return { ok:false, error:"Your opening play must include the 3 of diamonds." };
  if (lastPlay && !compareCombo(c, lastPlay.combo))
    return { ok:false, error:"Play a stronger combination of the same size, or pass." };
  return { ok:true, combo:c };
}

const rooms = new Map();
const queue = [];
const socketToRoom = new Map();
const disconnectTimers = new Map();
const RECONNECT_GRACE_MS = 30000;

function cleanName(name) {
  return String(name || "Player").trim().replace(/[<>]/g, "").slice(0,18) || "Player";
}
function publicRoom(room, viewerId) {
  return {
    code: room.code, mode: room.mode, phase: room.phase,
    players: room.players.map((p,i)=>({
      id:p.id, name:p.name, seat:i, connected:!!p.socketId,
      cardCount:p.hand.length, isYou:p.id===viewerId
    })),
    currentPlayerId: room.currentPlayerId,
    lastPlay: room.lastPlay ? { playerId:room.lastPlay.playerId, playerName:room.lastPlay.playerName, cards:room.lastPlay.cards, size:room.lastPlay.cards.length } : null,
    passed: [...room.passed], message: room.message,
    winner: room.winner ? {id:room.winner.id,name:room.winner.name}:null,
    turnNumber: room.turnNumber
  };
}
function emitState(room) {
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit("game:state", {
      ...publicRoom(room,p.id),
      hand: p.hand.map(c=>({...c})),
      legalHint: room.phase==="playing" && room.currentPlayerId===p.id
    });
  });
}
function roomBroadcast(room, event, payload) {
  room.players.forEach(p => { if (p.socketId) io.to(p.socketId).emit(event,payload); });
}
function leaveQueue(socketId) {
  const i = queue.findIndex(x=>x.socketId===socketId);
  if (i >= 0) queue.splice(i,1);
  io.emit("queue:count", { waiting:queue.length });
}
function makeRoom(mode, host) {
  let code;
  do { code = Math.random().toString(36).slice(2,7).toUpperCase(); } while (rooms.has(code));
  const room = { code, mode, hostId:host.id, players:[host], phase:"lobby", currentPlayerId:null, lastPlay:null, passed:new Set(), message:"Waiting for players", winner:null, turnNumber:0, mustContainThreeD:false, createdAt:Date.now() };
  rooms.set(code,room); socketToRoom.set(host.socketId,code);
  return room;
}
function beginGame(room) {
  if (room.players.length < 2 || room.phase==="playing") return;
  const cards = shuffle(deck());
  room.players.forEach((p,i)=> { p.hand = sortHand(cards.slice(i*13,(i+1)*13)); p.socketId && io.to(p.socketId).emit("game:notice",{type:"info",text:"Game started — good luck!"}); });
  // If fewer than four players joined, deal a balanced hand count and retain unused cards in a discard pile.
  if (room.players.length < 4) {
    const used = room.players.length * 13;
    room.unused = cards.slice(used);
  }
  room.phase="playing"; room.lastPlay=null; room.passed=new Set(); room.winner=null; room.turnNumber=0;
  const starter = room.players.find(p=>p.hand.some(c=>c.rank==="3"&&c.suit==="D"));
  room.currentPlayerId = starter.id; room.mustContainThreeD = true; room.message = `${starter.name} has the 3♦ and starts.`;
  emitState(room);
}
function matchQueue() {
  while (queue.length >= 4) {
    const group = queue.splice(0,4);
    const unique = group.filter((entry,i,arr)=>arr.findIndex(x=>x.playerId===entry.playerId)===i);
    if (unique.length < 4) { queue.unshift(...unique); break; }
    const players = unique.map(x=>({id:x.playerId,name:x.name,socketId:x.socketId,hand:[],connected:true}));
    const room = makeRoom("public",players[0]);
    room.players = players; room.hostId = null;
    players.forEach(p=>socketToRoom.set(p.socketId,room.code));
    room.phase="countdown"; room.message="Match found! Starting in 3 seconds…";
    players.forEach(p=>io.to(p.socketId).emit("match:found",{code:room.code,players:players.map(q=>({id:q.id,name:q.name}))}));
    roomBroadcast(room,"game:state", { ...publicRoom(room, ""), hand:[], countdown:3 });
    setTimeout(()=> { if (rooms.has(room.code) && room.phase==="countdown") beginGame(room); },3000);
  }
  io.emit("queue:count",{waiting:queue.length});
}
function detachFromRoom(socket, intentional=false) {
  const code = socketToRoom.get(socket.id);
  if (!code) return;
  socketToRoom.delete(socket.id);
  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.find(x=>x.socketId===socket.id);
  if (!p) return;
  p.socketId = null;
  if (intentional || room.phase==="lobby" || room.phase==="countdown") {
    room.players = room.players.filter(x=>x.id!==p.id);
    if (room.players.length===0) { rooms.delete(code); return; }
    if (room.mode==="private" && room.hostId===p.id) room.hostId=room.players[0].id;
    if (room.phase==="countdown" && room.players.length<4) { room.phase="lobby"; room.message="A player left. Waiting for players."; }
    roomBroadcast(room,"game:notice",{type:"warning",text:`${p.name} left the room.`});
    emitState(room);
    return;
  }
  roomBroadcast(room,"game:notice",{type:"warning",text:`${p.name} disconnected. They have 30 seconds to reconnect.`});
  const timer = setTimeout(()=>{
    const live = rooms.get(code);
    if (!live) return;
    const missing = live.players.find(x=>x.id===p.id);
    if (!missing || missing.socketId) return;
    if (live.phase==="playing") {
      live.players = live.players.filter(x=>x.id!==p.id);
      if (live.players.length < 2) { live.phase="ended"; live.message="Not enough players remain. Game ended."; }
      else if (live.currentPlayerId===p.id) advanceTurn(live);
      emitState(live);
    }
  },RECONNECT_GRACE_MS);
  disconnectTimers.set(p.id,timer);
  emitState(room);
}
function advanceTurn(room) {
  if (room.phase!=="playing" || !room.players.length) return;
  if (room.lastPlay && room.passed.size >= room.players.filter(p=>p.id!==room.lastPlay.playerId).length) {
    room.currentPlayerId=room.lastPlay.playerId;
    room.message=`${room.lastPlay.playerName} wins the trick and leads again.`;
    room.lastPlay=null; room.passed.clear(); room.mustContainThreeD=false;
    return;
  }
  const currentIndex = room.players.findIndex(p=>p.id===room.currentPlayerId);
  for (let step=1;step<=room.players.length;step++) {
    const candidate=room.players[(currentIndex+step)%room.players.length];
    if (candidate && !room.passed.has(candidate.id)) { room.currentPlayerId=candidate.id; break; }
  }
}
function doPlay(socket, data) {
  const code=socketToRoom.get(socket.id), room=rooms.get(code);
  if (!room || room.phase!=="playing") return socket.emit("game:error","No active game found.");
  const player=room.players.find(p=>p.socketId===socket.id);
  if (!player || player.id!==room.currentPlayerId) return socket.emit("game:error","It is not your turn.");
  const ids=Array.isArray(data?.cardIds)?data.cardIds:[];
  if (!ids.length || new Set(ids).size!==ids.length) return socket.emit("game:error","Select cards to play.");
  const selected=ids.map(id=>player.hand.find(c=>c.id===id));
  if (selected.some(c=>!c)) return socket.emit("game:error","One or more selected cards are not in your hand.");
  const result=validPlay(selected,room.lastPlay,room.mustContainThreeD);
  if (!result.ok) return socket.emit("game:error",result.error);
  player.hand=player.hand.filter(c=>!ids.includes(c.id));
  room.lastPlay={playerId:player.id,playerName:player.name,cards:selected.map(c=>({...c})),combo:result.combo};
  room.passed.clear(); room.mustContainThreeD=false; room.turnNumber++;
  if (player.hand.length===0) {
    room.phase="ended"; room.winner=player; room.message=`${player.name} wins!`;
    emitState(room); roomBroadcast(room,"game:notice",{type:"success",text:`${player.name} wins the game!`}); return;
  }
  room.message=`${player.name} played ${selected.length} card${selected.length===1?"":"s"}.`;
  advanceTurn(room); emitState(room);
}
function doPass(socket) {
  const code=socketToRoom.get(socket.id), room=rooms.get(code);
  if (!room || room.phase!=="playing") return socket.emit("game:error","No active game found.");
  const player=room.players.find(p=>p.socketId===socket.id);
  if (!player || player.id!==room.currentPlayerId) return socket.emit("game:error","It is not your turn.");
  if (!room.lastPlay || room.lastPlay.playerId===player.id) return socket.emit("game:error","You cannot pass when leading a new trick.");
  room.passed.add(player.id); room.turnNumber++; room.message=`${player.name} passed.`;
  advanceTurn(room); emitState(room);
}

io.on("connection", socket => {
  socket.emit("queue:count",{waiting:queue.length});
  socket.on("queue:join", raw => {
    if (socketToRoom.has(socket.id)) return socket.emit("game:error","You are already in a room.");
    leaveQueue(socket.id);
    const playerId=randomUUID();
    const entry={socketId:socket.id,playerId,name:cleanName(raw?.name),joinedAt:Date.now()};
    socket.data.playerId=playerId; socket.data.playerName=entry.name;
    queue.push(entry);
    socket.emit("queue:joined",{playerId,position:queue.length});
    io.emit("queue:count",{waiting:queue.length});
    matchQueue();
  });
  socket.on("queue:leave",()=> { leaveQueue(socket.id); });
  socket.on("room:create", raw => {
    if (socketToRoom.has(socket.id)) return socket.emit("game:error","You are already in a room.");
    const player={id:randomUUID(),name:cleanName(raw?.name),socketId:socket.id,hand:[],connected:true};
    socket.data.playerId=player.id; socket.data.playerName=player.name;
    const room=makeRoom("private",player);
    socket.emit("room:created",{code:room.code});
    emitState(room);
  });
  socket.on("room:join", raw => {
    if (socketToRoom.has(socket.id)) return socket.emit("game:error","You are already in a room.");
    const code=String(raw?.code||"").trim().toUpperCase(), room=rooms.get(code);
    if (!room) return socket.emit("game:error","Room not found.");
    if (room.mode!=="private" || room.phase!=="lobby") return socket.emit("game:error","That room is not accepting players.");
    if (room.players.length>=4) return socket.emit("game:error","That room is full.");
    const player={id:randomUUID(),name:cleanName(raw?.name),socketId:socket.id,hand:[],connected:true};
    room.players.push(player); socket.data.playerId=player.id; socket.data.playerName=player.name; socketToRoom.set(socket.id,code);
    room.message=`${player.name} joined the room.`; emitState(room);
  });
  socket.on("room:start",()=>{
    const room=rooms.get(socketToRoom.get(socket.id));
    if (!room || room.mode!=="private") return socket.emit("game:error","Private room not found.");
    if (room.hostId!==socket.data.playerId) return socket.emit("game:error","Only the host can start this room.");
    if (room.players.length<2) return socket.emit("game:error","At least two players are required.");
    beginGame(room);
  });
  socket.on("game:play",data=>doPlay(socket,data));
  socket.on("game:pass",()=>doPass(socket));
  socket.on("game:rematch",()=>{
    const room=rooms.get(socketToRoom.get(socket.id));
    if (!room || room.phase!=="ended") return;
    room.players.forEach(p=>p.hand=[]); room.phase="lobby"; room.winner=null; room.lastPlay=null; room.passed.clear(); room.message="Ready for another game.";
    if (room.mode==="public") {
      const players=[...room.players];
      rooms.delete(room.code);
      players.forEach(p=>{if(p.socketId){socketToRoom.delete(p.socketId);io.to(p.socketId).emit("game:notice",{type:"info",text:"Return to Quick Match to find new players."});}});
      return;
    }
    emitState(room);
  });
  socket.on("room:leave",()=>detachFromRoom(socket,true));
  socket.on("disconnect",()=>{leaveQueue(socket.id);detachFromRoom(socket,false);});
});

server.listen(PORT,()=>console.log(`Big 2 server listening on ${PORT}`));
