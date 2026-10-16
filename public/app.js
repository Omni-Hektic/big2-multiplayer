const socket = io();
const $ = id => document.getElementById(id);
const views = ["home","waiting","lobby","game","rules"];
let state = null, selected = new Set(), myPlayerId = null, myName = "", roomCode = "", inQueue = false, previousView = "game";
function show(id){ views.forEach(v=>$(v).classList.toggle("hidden",v!==id)); }
function toast(message,type=""){const t=$("toast");t.textContent=message;t.className="toast "+type;setTimeout(()=>t.classList.add("hidden"),3200);}
function getName(){myName=$("playerName").value.trim().slice(0,18)||"Player";$("playerName").value=myName;return myName;}
function suitSymbol(s){return ({D:"♦",C:"♣",H:"♥",S:"♠"})[s]||s;}
function cardEl(card, selectable=false){const el=document.createElement("div");el.className="card "+(["D","H"].includes(card.suit)?"red":"");el.innerHTML=`<span class="corner">${card.rank}<small>${suitSymbol(card.suit)}</small></span><span>${suitSymbol(card.suit)}</span>`;if(selectable){el.dataset.id=card.id;el.classList.toggle("selected",selected.has(card.id));el.onclick=()=>{selected.has(card.id)?selected.delete(card.id):selected.add(card.id);renderHand();};}return el;}
function renderHand(){const host=$("myCards");host.innerHTML="";(state?.hand||[]).forEach(c=>host.appendChild(cardEl(c,true)));$("playCards").disabled=!state||state.phase!=="playing"||state.currentPlayerId!==myPlayerId||selected.size===0;$("passTurn").disabled=!state||state.phase!=="playing"||state.currentPlayerId!==myPlayerId||!state.lastPlay||state.lastPlay.playerId===myPlayerId;}
function renderState(s){state=s;if(s.code)roomCode=s.code;if(s.players?.some(p=>p.isYou))myPlayerId=s.players.find(p=>p.isYou).id;
 if(s.phase==="lobby"){show("lobby");$("createdCode").textContent=s.code;$("startPrivate").classList.toggle("hidden",!s.players.some(p=>p.isYou&&p.seat===0));$("lobbyPlayers").innerHTML=s.players.map(p=>`<div class="player-row"><span>${escapeHtml(p.name)}${p.isYou?" (you)":""}</span><span>${p.connected?"● Connected":"○ Disconnected"}</span></div>`).join("");return;}
 if(s.phase==="countdown"){show("waiting");$("waitingTitle").textContent="Table found!";$("waitingText").textContent="Your game is starting…";$("queueCount").textContent="4";return;}
 show("game");$("tableCode").textContent=s.code||"";$("gameStatus").textContent=s.phase==="ended"?(s.winner?`${s.winner.name} wins!`:"Game ended"):s.phase==="playing"?(s.currentPlayerId===myPlayerId?"Your turn":"Game in progress"):"Connecting…";
 $("tableMessage").textContent=s.message||"";$("turnStatus").textContent=s.phase==="ended"?"Round complete":s.currentPlayerId===myPlayerId?"Your turn — choose your cards":`${s.players.find(p=>p.id===s.currentPlayerId)?.name||"A player"} is thinking`;
 const opp=$("opponents");opp.innerHTML="";const others=(s.players||[]).filter(p=>!p.isYou);others.forEach(p=>{const d=document.createElement("div");d.className="opponent"+(p.id===s.currentPlayerId?" active":"");d.innerHTML=`<div class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div><div class="name">${escapeHtml(p.name)}</div><div class="count">${p.cardCount} cards · ${p.connected?"online":"reconnecting"}</div>`;opp.appendChild(d);});
 const play=$("currentPlay");play.innerHTML="";if(s.lastPlay?.cards?.length){s.lastPlay.cards.forEach(c=>play.appendChild(cardEl(c)));}else play.innerHTML='<span class="muted">The table is clear</span>';
 if(s.phase==="ended"){$("endActions").classList.remove("hidden");$("playCards").disabled=true;$("passTurn").disabled=true;}else $("endActions").classList.add("hidden");
 renderHand();
}
function escapeHtml(str){return String(str).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("quickMatch").onclick=()=>{const name=getName();inQueue=true;show("waiting");$("waitingTitle").textContent="Finding your table…";$("waitingText").textContent="You’ll be seated as soon as four players are ready.";socket.emit("queue:join",{name});};
$("cancelQueue").onclick=()=>{socket.emit("queue:leave");inQueue=false;show("home");};
$("createPrivate").onclick=()=>socket.emit("room:create",{name:getName()});
$("showPrivate").onclick=()=> $("joinPrivate").classList.toggle("hidden");
$("joinRoom").onclick=()=>{const code=$("roomCode").value.trim().toUpperCase();if(!code)return toast("Enter a room code.","error");socket.emit("room:join",{code,name:getName()});};
$("startPrivate").onclick=()=>socket.emit("room:start");
$("leaveLobby").onclick=()=>{socket.emit("room:leave");show("home");};
$("copyInvite").onclick=async()=>{const link=`${location.origin}/?room=${roomCode}`;try{await navigator.clipboard.writeText(link);toast("Invitation link copied.");}catch{toast(link);}};
$("playCards").onclick=()=>{if(!selected.size)return;socket.emit("game:play",{cardIds:[...selected]});selected.clear();renderHand();};
$("passTurn").onclick=()=>socket.emit("game:pass");
$("leaveGame").onclick=()=>{socket.emit("room:leave");state=null;selected.clear();show("home");};
$("rematch").onclick=()=>{socket.emit("game:rematch");selected.clear();if(state?.mode==="public"){show("home");toast("Choose Quick Match to find new players.");}};
$("backHome").onclick=()=>{socket.emit("room:leave");state=null;show("home");};
$("rulesButton").onclick=()=>{previousView="game";show("rules");};
$("closeRules").onclick=()=>show(previousView);
socket.on("queue:count",d=>{if(inQueue)$("queueCount").textContent=Math.min(4,d.waiting||0);});
socket.on("queue:joined",d=>{inQueue=true;$("waitingText").textContent=`You’re in the queue (position ${d.position}). Waiting for three more players.`;});
socket.on("match:found",d=>{inQueue=false;roomCode=d.code;myPlayerId=socket.id;show("waiting");$("waitingTitle").textContent="Table found!";$("waitingText").textContent="Your match is ready. Dealing cards…";$("queueCount").textContent="4";});
socket.on("room:created",d=>{roomCode=d.code;toast("Private room created. Share the code with friends.");});
socket.on("game:state",renderState);
socket.on("game:error",msg=>toast(msg,"error"));
socket.on("game:notice",n=>toast(n.text,n.type==="warning"?"error":""));
socket.on("connect",()=>{const room=new URLSearchParams(location.search).get("room");if(room){$("roomCode").value=room.toUpperCase();$("joinPrivate").classList.remove("hidden");}});
socket.on("disconnect",()=>toast("Connection lost. Reconnecting…","error"));
