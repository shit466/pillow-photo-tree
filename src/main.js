import './style.css';
import { createPhotoScene } from './scene.js';
import { createHandController, probeHandWorker } from './gestures.js';
import { createWishes, resetWishes } from './wishes.js';

const $=id=>document.getElementById(id);
let scene,hand,wishes,destroyed=false,interactions=0,control='touch',gestureFocus=false,wishFlight=false,cameraRequest=0;
let toastTimer,starTimer,flightTimer,debugPanel;
function toast(message){if(destroyed)return;$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4300);}
function dismissInvite(){$('camera-invite').classList.add('dismissed');$('camera-invite').inert=true;$('camera-invite').setAttribute('aria-hidden','true');}
function interacted(){interactions++;if(interactions>=8)unlockStar();}
function unlockStar(){if(!scene||wishes.unlocked)return;wishes.unlock();scene.unlockStar();}
function focus(index,fromGesture=false){if(wishFlight||wishes.opened)return;if(!scene.focus(index))return;gestureFocus=fromGesture;$('focus-caption').textContent=scene.entries[index].title||'';$('focus-ui').hidden=false;document.body.classList.add('is-focused');interacted();}
function blur(){if(!scene)return;scene.blur();gestureFocus=false;$('focus-ui').hidden=true;document.body.classList.remove('is-focused');}
function changeMode(mode){if(wishFlight||wishes.opened)return;scene.setMode(mode);$('mode-label').textContent=mode==='galaxy'?'照片宇宙':'照片树';$('view-toggle').querySelector('span').textContent=mode==='galaxy'?'回到照片树':'照片宇宙';interacted();}
function setControl(mode){control=mode;$('control-toggle').querySelector('span').textContent=mode==='gesture'?'手势':'触控';$('interaction-hint').textContent=mode==='gesture'?'挥手旋转 · 捏合照片 · 张掌进入宇宙':'轻拖旋转 · 双指缩放 · 点开照片';if(mode==='touch'){$('gesture-cursor').classList.remove('visible','pinching');gestureFocus&&blur();}}
async function startCamera(){if(wishFlight||wishes.opened)return;const request=++cameraRequest;$('camera-start').disabled=true;$('camera-start').lastChild.textContent=' 正在连接…';const ok=await hand.start();if(request!==cameraRequest||destroyed)return;if(ok){setControl('gesture');dismissInvite();toast('手势已开启，挥挥手试试看。');}else setControl('touch');$('camera-start').disabled=false;$('camera-start').lastChild.textContent='开启手势控制';}
function stopCamera(){cameraRequest++;hand.stop();setControl('touch');$('camera-start').disabled=false;$('camera-start').lastChild.textContent='开启手势控制';}
function enterWish(unlocked){if(!unlocked||wishFlight||wishes.opened)return;blur();wishFlight=true;scene.zoomStar(true);$('app').classList.add('star-flight');dismissInvite();stopCamera();flightTimer=setTimeout(()=>{if(destroyed)return;wishes.open();wishFlight=false;scene.pause(true);},1500);}
function fatal(message){$('loading').classList.add('done');$('error-message').textContent=message;$('error-screen').hidden=false;}

async function init(){
  try {
    scene=await createPhotoScene({container:$('scene'),onSelect:i=>focus(i),onStar:enterWish,onPhotoError:toast,onStats:stats=>{if(debugPanel)debugPanel.textContent=`${stats.fps} fps · Q${stats.quality}\n${stats.particles} particles\n${stats.textures} textures · ${stats.drawCalls} calls\n${hand?.stats?.backend||'camera off'}`;}});
  }catch(error){console.error(error);fatal('浏览器暂不支持 WebGL，或图形资源不足。请关闭一些标签页，再使用 Safari 或 Chrome 打开。');return;}
  wishes=createWishes({onOpen:()=>{document.body.classList.add('wishes-open');},onClose:()=>{document.body.classList.remove('wishes-open');$('app').classList.remove('star-flight');scene.zoomStar(false);scene.pause(document.hidden);},onUse:()=>interacted(),onToast:toast});
  hand=createHandController({
    onRotate:velocity=>{if(wishFlight||wishes.opened||scene.focused>=0)return;scene.rotateImpulse(velocity);},
    onScale:value=>{if(!wishFlight&&!wishes.opened){scene.setScale(value);}},
    getScale:()=>scene.scale,getMode:()=>scene.mode,
    onPinch:({x,y})=>{if(wishFlight||wishes.opened)return;const hit=scene.pick(x,y,true);if(hit?.type==='photo'){focus(hit.index,true);$('gesture-cursor').classList.add('pinching');}},
    onPinchEnd:()=>{if(gestureFocus)blur();$('gesture-cursor').classList.remove('pinching');},
    onMode:changeMode,
    onPointer:({x,y,visible})=>{const c=$('gesture-cursor');c.style.left=`${x*100}%`;c.style.top=`${y*100}%`;c.classList.toggle('visible',visible&&control==='gesture'&&!wishes.opened);},
    onStatus:({state,message})=>{if(state==='error'){hand.stop();setControl('touch');dismissInvite();toast(message||'没关系，也可以用手指控制。');}else if(state==='loading')toast('正在唤醒手势，稍等片刻…');else if(state==='active'){setControl('gesture');dismissInvite();}},
    onQuality:()=>{}
  });
  $('loading').classList.add('done');setTimeout(()=>$('loading').hidden=true,1100);
  starTimer=setTimeout(unlockStar,42000);
  bindControls();
  scene.entries.forEach((entry,index)=>{const button=document.createElement('button');button.textContent=entry.title||`照片 ${index+1}`;button.addEventListener('click',()=>{$('help-dialog').close();focus(index);});$('photo-list').append(button);});
  if(new URLSearchParams(location.search).get('debug')==='1'){
    debugPanel=document.createElement('div');debugPanel.className='debug-panel';debugPanel.style.whiteSpace='pre';document.body.append(debugPanel);
    const probeButton=document.createElement('button');probeButton.className='probe-button';probeButton.textContent='测试模型（无摄像头）';probeButton.addEventListener('click',async()=>{probeButton.disabled=true;probeButton.textContent='模型测试中…';try{const result=await probeHandWorker();probeButton.textContent=`${result.backend} · ${result.handCount} hands · ${Math.round(result.inferenceMs)}ms`;probeButton.dataset.result='passed';}catch(error){probeButton.textContent=`测试失败：${error.message}`;probeButton.dataset.result='failed';console.error(error);}finally{probeButton.disabled=false;}});document.body.append(probeButton);
    window.photoTreeDebug={getStats:()=>scene.getStats(),getHandStats:()=>hand.stats,unlockStar,openWishes:()=>{unlockStar();enterWish(true);},resetWishes,focus,blur,setMode:changeMode,setScale:value=>scene.setScale(value),destroy};
  }
}

function bindControls(){
  $('camera-start').addEventListener('click',startCamera);
  $('use-touch').addEventListener('click',()=>{stopCamera();dismissInvite();});
  $('control-toggle').addEventListener('click',()=>{if(control==='gesture'||$('camera-start').disabled){stopCamera();dismissInvite();}else void startCamera();});
  $('view-toggle').addEventListener('click',()=>{dismissInvite();blur();changeMode(scene.mode==='tree'?'galaxy':'tree');});
  $('soundless-reset').addEventListener('click',()=>{blur();scene.reset();});
  $('focus-close').addEventListener('click',blur);
  $('help-button').addEventListener('click',()=>{$('help-dialog').showModal();});
  $('help-close').addEventListener('click',()=>{$('help-dialog').close();});
  $('help-dialog').addEventListener('click',e=>{if(e.target===$('help-dialog')){const r=$('help-dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('help-dialog').close();}});
  const pointers=new Map();let lastX=0,lastTime=0,startX=0,startY=0,moved=false,multi=false,distanceBase=0,scaleBase=1;
  const surface=$('scene');
  function pairDistance(){const [a,b]=[...pointers.values()];return a&&b?Math.hypot(a.x-b.x,a.y-b.y):0;}
  surface.addEventListener('pointerdown',e=>{if(wishFlight||wishes.opened)return;if(e.pointerType==='mouse'&&e.button!==0)return;surface.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===1){lastX=startX=e.clientX;startY=e.clientY;lastTime=performance.now();moved=false;multi=false;}
    if(pointers.size===2){multi=true;distanceBase=pairDistance();scaleBase=scene.scale;moved=true;blur();}
  });
  surface.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size>=2){if(distanceBase>8)scene.setScale(scaleBase*pairDistance()/distanceBase);dismissInvite();return;}
    if(multi)return;const dx=e.clientX-lastX,now=performance.now(),dt=Math.max((now-lastTime)/1000,.008);if(Math.hypot(e.clientX-startX,e.clientY-startY)>5)moved=true;
    if(moved&&scene.focused<0){scene.rotateImpulse(clamp(dx/dt/Math.max(surface.clientWidth,1)*3.5,-3.8,3.8));dismissInvite();}
    lastX=e.clientX;lastTime=now;
  });
  function pointerEnd(e){if(!pointers.has(e.pointerId))return;const canTap=!moved&&!multi&&pointers.size===1;pointers.delete(e.pointerId);
    if(canTap){const r=surface.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;if(scene.focused>=0)blur();else scene.dispatchPick(x,y);interacted();}
    else if(pointers.size===0)interacted();if(!pointers.size)multi=false;
  }
  surface.addEventListener('pointerup',pointerEnd);surface.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);multi=pointers.size>0;});
  surface.addEventListener('wheel',e=>{e.preventDefault();scene.setScale(scene.scale*Math.exp(-e.deltaY*.001));dismissInvite();},{passive:false});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!wishes.opened)blur();if(e.target instanceof HTMLElement&&/BUTTON|INPUT|TEXTAREA/.test(e.target.tagName))return;if(e.key==='ArrowLeft')scene.rotateImpulse(-1);if(e.key==='ArrowRight')scene.rotateImpulse(1);});
  document.addEventListener('visibilitychange',()=>{scene.pause(document.hidden||wishes.opened);});
  addEventListener('pagehide',e=>{if(e.persisted){scene.pause(true);}else destroy();});
  addEventListener('pageshow',e=>{if(e.persisted&&!destroyed)scene.pause(document.hidden||wishes.opened);});
}
function clamp(v,min,max){return Math.min(max,Math.max(min,v));}
function destroy(){if(destroyed)return;destroyed=true;clearTimeout(toastTimer);clearTimeout(starTimer);clearTimeout(flightTimer);hand?.destroy();scene?.destroy();wishes?.destroy();debugPanel?.remove();document.querySelector('.probe-button')?.remove();delete window.photoTreeDebug;}
$('reload').addEventListener('click',()=>location.reload());
// If the 3D/vision bundle cannot initialize, retain a friendly recoverable screen.
init().catch(error=>{console.error(error);fatal('星光暂时未能加载，请检查网络后重新打开。');});
