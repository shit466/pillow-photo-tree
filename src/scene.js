import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, speed, dt) => THREE.MathUtils.damp(a, b, speed, dt);
const BASE = import.meta.env.BASE_URL;
const BUILD_VERSION = __BUILD_VERSION__;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function rng(seed = 932817) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d'); const g = ctx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)'); g.addColorStop(.15,'rgba(255,255,255,.8)');
  g.addColorStop(.4,'rgba(255,255,255,.22)'); g.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=g;ctx.fillRect(0,0,64,64); return new THREE.CanvasTexture(c);
}
function placeholder(i) {
  const c=document.createElement('canvas');c.width=360;c.height=420;
  const x=c.getContext('2d');const g=x.createLinearGradient(0,0,360,420);
  g.addColorStop(0,'#293443');g.addColorStop(1,'#121b29');x.fillStyle=g;x.fillRect(0,0,360,420);
  x.fillStyle='#d8bf8c';x.font='32px serif';x.textAlign='center';x.fillText('✦',180,195);
  x.fillStyle='#8e949e';x.font='12px sans-serif';x.fillText(String(i+1).padStart(2,'0'),180,239);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
async function loadImageTexture(src, maxSize, signal) {
  const url = new URL(src, new URL(BASE,location.href));
  // Local photos only: no third-party image host receives a visitor's request.
  if(url.origin!==location.origin) throw new Error('照片配置仅支持站内文件');
  url.searchParams.set('v', BUILD_VERSION);
  const response=await fetch(url,{signal}); if(!response.ok)throw new Error('照片未找到');
  const blob=await response.blob();if(blob.size>16*1024*1024)throw new Error('照片过大，请先压缩');
  const objectURL=URL.createObjectURL(blob);const img=new Image();img.decoding='async';
  try {
    img.src=objectURL;await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('图片格式不受支持'));});
    if(signal.aborted)throw new DOMException('Aborted','AbortError');
    const ratio=img.naturalWidth/img.naturalHeight;const s=Math.min(1,maxSize/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*s));c.height=Math.max(1,Math.round(img.naturalHeight*s));
    c.getContext('2d',{alpha:false}).drawImage(img,0,0,c.width,c.height);
    const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;
    texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;
    return {texture,ratio};
  } finally { img.src='';URL.revokeObjectURL(objectURL); }
}

export async function createPhotoScene({container,onSelect,onStar,onStats,onPhotoError}) {
  const random=rng(); const mobile=matchMedia('(pointer: coarse)').matches;
  const weak=(navigator.hardwareConcurrency||4)<=4 || (navigator.deviceMemory && navigator.deviceMemory<=4);
  let quality=weak?0:mobile?1:2;
  const levels=[{particles:1700,stars:220,dpr:1.15,firework:90},{particles:3000,stars:380,dpr:1.5,firework:130},{particles:4800,stars:620,dpr:1.8,firework:180}];
  const maxCount=levels[quality].particles;
  const renderer=new THREE.WebGLRenderer({antialias:!weak,alpha:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,levels[quality].dpr));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.setClearColor(0x060912,0);
  container.append(renderer.domElement);renderer.domElement.setAttribute('aria-hidden','true');
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(42,1,.1,80);
  const root=new THREE.Group();scene.add(root);
  const glow=glowTexture();const abort=new AbortController();
  let destroyed=false,paused=false,raf=0,clock=0,last=performance.now(),mode='tree',mix=0,mixTarget=0;
  let scale=1,scaleTarget=1,velocity=0,focusIndex=-1,focusAmount=0,focusTarget=0,starUnlocked=false,starZoom=0,starZoomTarget=0;
  let intro=0,dim=1,frameCount=0,sampleTime=0,slowWindows=0,stats={fps:60,quality,particles:maxCount,photos:0};
  const particleGeo=new THREE.BufferGeometry();
  const tree=new Float32Array(maxCount*3),galaxy=new Float32Array(maxCount*3),colors=new Float32Array(maxCount*3),sizes=new Float32Array(maxCount);
  const palette=[new THREE.Color('#d8b474'),new THREE.Color('#f2d5a1'),new THREE.Color('#a9976d'),new THREE.Color('#ffffff'),new THREE.Color('#758792')];
  for(let i=0;i<maxCount;i++) {
    const h=random(),angle=random()*Math.PI*2;
    const radius=(1-h)*1.8*(i%3===0?.96:Math.sqrt(random()));
    const ripple=1+.075*Math.cos(h*17*Math.PI);
    tree[i*3]=Math.cos(angle)*radius*ripple;tree[i*3+1]=h*4.7-2.35;tree[i*3+2]=Math.sin(angle)*radius*ripple;
    const ga=random()*Math.PI*2,gr=2+Math.sqrt(random())*5.2;
    galaxy[i*3]=Math.cos(ga)*gr;galaxy[i*3+1]=(random()-.5)*7.5;galaxy[i*3+2]=Math.sin(ga)*gr*.72;
    const col=palette[i%15===0?3:i%11===0?4:i%3];col.toArray(colors,i*3);sizes[i]=.7+random()*2;
  }
  // A luminous helix is woven into the same draw call as the tree dust.
  for(let i=0;i<maxCount;i+=4) {
    const h=((i/4)*.6180339887499)%1,a=h*Math.PI*2*5.7,r=(1-h)*1.88+.02;
    tree[i*3]=Math.cos(a)*r;tree[i*3+1]=h*4.7-2.35;tree[i*3+2]=Math.sin(a)*r;sizes[i]=1.7+random()*1.2;
    palette[1].toArray(colors,i*3);
  }
  particleGeo.setAttribute('position',new THREE.BufferAttribute(tree,3));
  particleGeo.setAttribute('galaxy',new THREE.BufferAttribute(galaxy,3));
  particleGeo.setAttribute('color',new THREE.BufferAttribute(colors,3));
  particleGeo.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));
  particleGeo.boundingSphere=new THREE.Sphere(new THREE.Vector3(),14);
  const uniforms={uMix:{value:0},uTime:{value:0},uIntro:{value:0},uOpacity:{value:1},uPixel:{value:renderer.getPixelRatio()}};
  const particleMat=new THREE.ShaderMaterial({uniforms,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    vertexShader:`attribute vec3 galaxy;attribute float aSize;uniform float uMix,uTime,uIntro,uPixel;varying vec3 vColor;
    void main(){vColor=color;vec3 p=mix(position,galaxy,uMix);p+=sin(uTime*.22+galaxy)*(.016+.045*uMix);p=mix(galaxy*.45,p,uIntro);vec4 v=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*v;gl_PointSize=clamp(aSize*25.*uPixel/-v.z,1.,8.);}`,
    fragmentShader:`uniform float uOpacity;varying vec3 vColor;void main(){float d=length(gl_PointCoord-.5)*2.;if(d>1.)discard;float a=pow(1.-d,2.5)*uOpacity;gl_FragColor=vec4(vColor,a);}`});
  const dust=new THREE.Points(particleGeo,particleMat);root.add(dust);

  const starsGeo=new THREE.BufferGeometry();const sp=new Float32Array(levels[quality].stars*3);
  for(let i=0;i<sp.length/3;i++){sp[i*3]=(random()-.5)*42;sp[i*3+1]=(random()-.5)*29;sp[i*3+2]=-12-random()*18;}
  starsGeo.setAttribute('position',new THREE.BufferAttribute(sp,3));
  const starsMat=new THREE.PointsMaterial({color:'#c4d0df',size:.11,map:glow,transparent:true,opacity:.64,depthWrite:false,blending:THREE.AdditiveBlending});
  const stars=new THREE.Points(starsGeo,starsMat);scene.add(stars);

  const starShape=new THREE.Shape();for(let i=0;i<10;i++){const a=Math.PI/2+i*Math.PI/5,r=i%2?.135:.3;const x=Math.cos(a)*r,y=Math.sin(a)*r;i?starShape.lineTo(x,y):starShape.moveTo(x,y);}starShape.closePath();
  const starGeo=new THREE.ExtrudeGeometry(starShape,{depth:.07,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.02,bevelThickness:.02});
  const starMat=new THREE.MeshBasicMaterial({color:'#f4d59a',side:THREE.DoubleSide});
  const star=new THREE.Mesh(starGeo,starMat);star.position.set(0,2.68,0);root.add(star);
  const starHaloMat=new THREE.SpriteMaterial({map:glow,color:'#d9ac61',transparent:true,opacity:.35,depthWrite:false,blending:THREE.AdditiveBlending});
  const starHalo=new THREE.Sprite(starHaloMat);starHalo.scale.set(1.7,1.7,1);star.add(starHalo);
  const starOrigin=star.position.clone(),starGalaxy=new THREE.Vector3(.5,3.15,1);

  const ringGeo=new THREE.RingGeometry(2,2.006,128);
  const ringMat=new THREE.MeshBasicMaterial({color:'#a68a58',transparent:true,opacity:.3,side:THREE.DoubleSide,depthWrite:false});
  const ring=new THREE.Mesh(ringGeo,ringMat);ring.rotation.x=-Math.PI/2;ring.position.y=-2.48;root.add(ring);
  const floorMat=new THREE.SpriteMaterial({map:glow,color:'#977846',transparent:true,opacity:.13,depthWrite:false,blending:THREE.AdditiveBlending});
  const floor=new THREE.Sprite(floorMat);floor.position.set(0,-2.55,0);floor.scale.set(6,.4,1);root.add(floor);
  const ornaments=[];const ornamentGeo=new THREE.SphereGeometry(.045,8,6),ornamentMat=new THREE.MeshBasicMaterial({color:'#dbc49c'});
  for(let i=0;i<16;i++){const h=.15+random()*.65,a=random()*Math.PI*2,r=(1-h)*1.8;const mesh=new THREE.Mesh(ornamentGeo,ornamentMat);const home=new THREE.Vector3(Math.cos(a)*r,h*4.7-2.35,Math.sin(a)*r);mesh.position.copy(home);root.add(mesh);ornaments.push({mesh,home,away:new THREE.Vector3((random()-.5)*10,(random()-.5)*6,(random()-.5)*8)});}

  let manifest;
  try{const r=await fetch(`${BASE}photos.json?v=${BUILD_VERSION}`,{signal:abort.signal});if(!r.ok)throw new Error();manifest=await r.json();}
  catch{manifest={photos:[]};onPhotoError?.('照片配置没有找到，可以先转动星光树。');}
  const entries=(Array.isArray(manifest)?manifest:manifest.photos||[]).map(p=>typeof p==='string'?{src:p,alt:'照片'}:p).filter(p=>p&&typeof p.src==='string').slice(0,36);
  if(!entries.length)onPhotoError?.('还没有照片，放入 photos 文件夹后即可点亮。');
  const photos=[];const planeGeo=new THREE.PlaneGeometry(1,1);
  for(let i=0;i<entries.length;i++) {
    const entry=entries[i],orbit=i%2===0;
    const h=.1+(i/(Math.max(1,entries.length-1)))*.76;
    const a=(i*2.39996)+.35;
    const r=orbit?2.2+.15*Math.sin(i):(1-h)*1.85+.24;
    const home=new THREE.Vector3(Math.sin(a)*r,h*4.2-2,Math.cos(a)*r);
    if(entries.length<=18&&orbit){const slot=Math.floor(i/2);home.set((slot%2?-1:1)*(2.0+.1*Math.sin(i)),h*3.9-1.85,(slot%3-1)*.65);}
    const ga=i*2.39996,gr=2.3+(i%4)*.46;
    const away=new THREE.Vector3(Math.cos(ga)*gr,(i/(Math.max(1,entries.length-1))-.5)*5.2,Math.sin(ga)*2.6);
    const group=new THREE.Group();const map=placeholder(i);
    const imageMat=new THREE.MeshBasicMaterial({map,side:THREE.DoubleSide,transparent:true,toneMapped:false,forceSinglePass:true});
    const frameMat=new THREE.MeshBasicMaterial({color:'#e7dbc3',side:THREE.DoubleSide,transparent:true,toneMapped:false,forceSinglePass:true});
    const shadowMat=new THREE.MeshBasicMaterial({color:'#02050b',transparent:true,opacity:.28,side:THREE.DoubleSide,depthWrite:false,forceSinglePass:true});
    const shadow=new THREE.Mesh(planeGeo,shadowMat);shadow.position.set(.035,-.04,-.035);
    const frame=new THREE.Mesh(planeGeo,frameMat);const image=new THREE.Mesh(planeGeo,imageMat);image.position.z=.009;image.userData.photoIndex=i;
    group.add(shadow,frame,image);group.position.copy(home);root.add(group);
    const data={entry,group,image,imageMat,frame,frameMat,shadow,shadowMat,home,away,ratio:.85,width:.78,height:.92,tilt:(random()-.5)*.18,loaded:false};
    photos.push(data);setDimensions(data,.85);
  }
  function setDimensions(p,ratio){p.ratio=clamp(ratio,.52,1.85);p.width=ratio>1?.98:.78;p.height=p.width/p.ratio;p.image.scale.set(p.width,p.height,1);p.frame.scale.set(p.width+.055,p.height+.09,1);p.shadow.scale.set(p.width+.08,p.height+.11,1);}
  let pendingIndex=0;
  async function loadNext(limit) {
    while(!destroyed && pendingIndex<limit){const i=pendingIndex++,p=photos[i];
      if(/\.hei[cf](\?|$)/i.test(p.entry.src)){onPhotoError?.('HEIC 照片请先转换为 JPG 或 WEBP。');continue;}
      const timeoutController=new AbortController();const cancel=()=>timeoutController.abort();abort.signal.addEventListener('abort',cancel,{once:true});const timeout=setTimeout(cancel,18000);
      try{const loaded=await loadImageTexture(p.entry.src,quality?960:640,timeoutController.signal);
        if(destroyed){loaded.texture.dispose();return;}
        p.imageMat.map.dispose();p.imageMat.map=loaded.texture;p.imageMat.needsUpdate=true;p.loaded=true;setDimensions(p,loaded.ratio);
      }catch(e){if(!destroyed)onPhotoError?.(/HEIC/i.test(p.entry.src)?'HEIC 照片请先转换为 JPG 或 WEBP。':'有一张照片未能加载，其他功能可以继续使用。');}
      finally{clearTimeout(timeout);abort.signal.removeEventListener('abort',cancel);}
    }
  }
  // First useful frame waits for at most six modest textures. Remaining images load in pairs.
  const initialLimit=Math.min(6,photos.length);
  await Promise.all([loadNext(initialLimit),loadNext(initialLimit)]);
  let lazyTimer=setTimeout(()=>{void Promise.all([loadNext(photos.length),loadNext(photos.length)]);},900);

  const bursts=[];const maxBurst=levels[quality].firework;
  for(let j=0;j<2;j++) {
    const positions=new Float32Array(maxBurst*3*3),geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
    const mat=new THREE.PointsMaterial({map:glow,size:.11,color:'#d8b68b',transparent:true,depthWrite:false,opacity:0,blending:THREE.AdditiveBlending});
    const points=new THREE.Points(geo,mat);points.frustumCulled=false;scene.add(points);
    const velocities=new Float32Array(maxBurst*3);bursts.push({geo,mat,points,positions,velocities,age:10,origin:new THREE.Vector3()});
  }
  let nextBurst=5+random()*5;
  function firework(){const burst=bursts.find(b=>b.age>3.8);if(!burst)return;burst.age=0;
    burst.origin.set((random()>.5?1:-1)*(4+random()*3),1.4+random()*3.5,-7-random()*3);
    burst.mat.color.set(['#d8b68b','#b9beca','#c8aa9d'][Math.floor(random()*3)]);
    for(let i=0;i<maxBurst;i++){const z=random()*2-1,a=random()*Math.PI*2,s=.6+random()*1.4,r=Math.sqrt(1-z*z);burst.velocities[i*3]=Math.cos(a)*r*s;burst.velocities[i*3+1]=Math.sin(a)*r*s;burst.velocities[i*3+2]=z*s;}
  }
  const meteorGeo=new THREE.BufferGeometry();const meteorPos=new Float32Array(24);meteorGeo.setAttribute('position',new THREE.BufferAttribute(meteorPos,3));
  const meteorMat=new THREE.LineBasicMaterial({color:'#d6d9e2',transparent:true,opacity:0,depthWrite:false});const meteor=new THREE.Line(meteorGeo,meteorMat);meteor.frustumCulled=false;scene.add(meteor);
  let meteorAge=10,nextMeteor=12+random()*12,meteorX=0;
  const raycaster=new THREE.Raycaster();const screenVec=new THREE.Vector3(),ndc=new THREE.Vector2(),quaternion=new THREE.Quaternion(),focusWorld=new THREE.Vector3(),forward=new THREE.Vector3(),temp=new THREE.Vector3();
  const baseCamera=new THREE.Vector3(),starWorld=new THREE.Vector3();
  let width=1,height=1,baseZ=10;
  function resize(){width=container.clientWidth;height=container.clientHeight;camera.aspect=width/Math.max(height,1);camera.updateProjectionMatrix();
    baseZ=Math.max(height<500?12.6:9.1,5.65/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*camera.aspect));baseCamera.set(0,.3,baseZ);renderer.setSize(width,height,false);}
  resize();const observer=new ResizeObserver(resize);observer.observe(container);
  function project(object){scene.updateMatrixWorld(true);object.getWorldPosition(screenVec);screenVec.project(camera);return{x:(screenVec.x+1)/2,y:(1-screenVec.y)/2,z:screenVec.z};}
  function pick(x,y,magnetic=false){ndc.set(x*2-1,1-y*2);scene.updateMatrixWorld(true);raycaster.setFromCamera(ndc,camera);
    const hits=raycaster.intersectObjects([star,...photos.map(p=>p.image)],false);
    if(hits.length){const object=hits[0].object;return object===star?{type:'star'}:{type:'photo',index:object.userData.photoIndex};}
    if(magnetic){let closest=null,distance=60;photos.forEach((p,index)=>{const pos=project(p.group),d=Math.hypot((pos.x-x)*width,(pos.y-y)*height);if(d<distance&&pos.z<1){distance=d;closest={type:'photo',index};}});return closest;}
    return null;
  }
  function dispatchPick(x,y,magnetic=false){const hit=pick(x,y,magnetic);if(hit?.type==='star')onStar?.(starUnlocked);else if(hit?.type==='photo')onSelect?.(hit.index);return hit;}
  function animate(now){if(destroyed||paused)return;raf=requestAnimationFrame(animate);const dt=Math.min((now-last)/1000,.05);last=now;clock+=dt;sampleTime+=dt;frameCount++;
    if(sampleTime>3){stats.fps=Math.round(frameCount/sampleTime);if(stats.fps<37&&!document.hidden)slowWindows++;else slowWindows=Math.max(0,slowWindows-1);
      if(slowWindows>=2&&quality>0){quality--;slowWindows=0;const q=levels[quality];particleGeo.setDrawRange(0,Math.min(q.particles,maxCount));renderer.setPixelRatio(Math.min(devicePixelRatio,q.dpr));renderer.setSize(width,height,false);uniforms.uPixel.value=renderer.getPixelRatio();starsGeo.setDrawRange(0,q.stars);stats.particles=Math.min(q.particles,maxCount);}
      stats.quality=quality;stats.photos=photos.length;stats.textures=renderer.info.memory.textures;stats.drawCalls=renderer.info.render.calls;onStats?.({...stats});frameCount=0;sampleTime=0;}
    intro=damp(intro,1,reducedMotion?20:1.6,dt);mix=damp(mix,mixTarget,reducedMotion?12:2.7,dt);scale=damp(scale,scaleTarget,7,dt);
    focusAmount=damp(focusAmount,focusTarget,focusTarget?6:5,dt);if(!focusTarget&&focusAmount<.003)focusIndex=-1;
    dim=damp(dim,focusTarget?.25:1,5,dt);starZoom=damp(starZoom,starZoomTarget,3,dt);
    root.scale.setScalar(scale);velocity*=Math.exp(-2.15*dt);root.rotation.y+=(velocity+(reducedMotion?0:focusAmount>.1?.035:.07))*dt;
    camera.position.copy(baseCamera);camera.position.z*=1+mix*(camera.aspect<1?.38:.12);camera.lookAt(0,.12,0);
    if(starZoom>.001){root.updateMatrixWorld(true);star.getWorldPosition(starWorld);temp.copy(starWorld).add(new THREE.Vector3(0,.03,1.7));camera.position.lerp(temp,starZoom);camera.lookAt(temp.copy(starWorld).lerp(new THREE.Vector3(0,.12,0),1-starZoom));}
    camera.updateMatrixWorld();root.updateMatrixWorld(true);
    uniforms.uMix.value=mix;uniforms.uIntro.value=intro;uniforms.uTime.value=clock;uniforms.uOpacity.value=dim*(.65+.35*intro);
    stars.rotation.y=clock*.003;starsMat.opacity=.58*dim;
    star.position.lerpVectors(starOrigin,starGalaxy,mix);star.rotation.y=-root.rotation.y;star.rotation.z=Math.sin(clock*.7)*.06;
    const pulse=starUnlocked?1+Math.pow(Math.max(0,Math.sin(clock*1.9)),9)*.15:1+Math.sin(clock*.9)*.025;star.scale.setScalar(pulse);
    starMat.color.setScalar(1);starMat.color.set('#f4d59a').multiplyScalar(.5+.5*dim);starHaloMat.opacity=(starUnlocked?.43+.18*Math.sin(clock*1.9):.34)*dim;
    ringMat.opacity=(1-mix)*.26*dim;floorMat.opacity=(1-mix)*.13*dim;
    ornaments.forEach(o=>{o.mesh.position.lerpVectors(o.home,o.away,mix);o.mesh.scale.setScalar(intro);});ornamentMat.color.set('#dbc49c').multiplyScalar(dim);
    quaternion.copy(root.quaternion).invert().multiply(camera.quaternion);
    photos.forEach((p,i)=>{
      p.group.position.lerpVectors(p.home,p.away,mix);p.group.position.y+=Math.sin(clock*.65+i*1.7)*.04;p.group.quaternion.copy(quaternion);p.group.rotateZ(p.tilt+Math.sin(clock*.3+i)*.012);
      let cardScale=intro*.93+.07;
      if(i===focusIndex){camera.getWorldDirection(forward);focusWorld.copy(camera.position).addScaledVector(forward,3.5);root.worldToLocal(focusWorld);p.group.position.lerp(focusWorld,focusAmount);
        const viewHeight=2*3.5*Math.tan(THREE.MathUtils.degToRad(camera.fov/2));const targetSize=Math.min(viewHeight*.65/p.height,viewHeight*camera.aspect*.83/p.width)/scale;
        cardScale=THREE.MathUtils.lerp(cardScale,targetSize,focusAmount);p.group.rotateZ(-p.tilt*focusAmount);}
      p.group.scale.setScalar(cardScale);const opacity=i===focusIndex?1:dim;p.imageMat.opacity=opacity;p.frameMat.opacity=opacity;p.shadowMat.opacity=.25*opacity;
    });
    if(!reducedMotion&&clock>nextBurst){firework();nextBurst=clock+5+random()*5+(quality===0?4:0);}
    bursts.forEach(b=>{b.age+=dt;if(b.age>4){b.mat.opacity=0;return;}const n=levels[quality].firework;b.geo.setDrawRange(0,n*3);b.mat.opacity=Math.pow(1-b.age/4,1.8)*.8*dim;
      for(let i=0;i<n;i++)for(let j=0;j<3;j++){const t=Math.max(0,b.age-j*.065),travel=(1-Math.exp(-t*.8))/.8;const k=(i*3+j)*3;b.positions[k]=b.origin.x+b.velocities[i*3]*travel;b.positions[k+1]=b.origin.y+b.velocities[i*3+1]*travel-t*t*.16;b.positions[k+2]=b.origin.z+b.velocities[i*3+2]*travel;}b.geo.attributes.position.needsUpdate=true;
    });
    if(!reducedMotion&&clock>nextMeteor){meteorAge=0;meteorX=-6+random()*10;nextMeteor=clock+14+random()*18;}meteorAge+=dt;
    if(meteorAge<1.6){meteorMat.opacity=Math.sin(meteorAge/1.6*Math.PI)*.4*dim;for(let i=0;i<8;i++){const t=meteorAge-i*.025;meteorPos[i*3]=meteorX+t*5;meteorPos[i*3+1]=6-t*3.8;meteorPos[i*3+2]=-8;}meteorGeo.attributes.position.needsUpdate=true;}else meteorMat.opacity=0;
    renderer.render(scene,camera);
  }
  function contextLost(event){event.preventDefault();api.pause(true);onPhotoError?.('浏览器暂时释放了图形资源，正在恢复…');}
  function contextRestored(){api.pause(false);onPhotoError?.('星光已恢复。');}
  renderer.domElement.addEventListener('webglcontextlost',contextLost);renderer.domElement.addEventListener('webglcontextrestored',contextRestored);
  const api={
    entries,
    get mode(){return mode;},get scale(){return scaleTarget;},get focused(){return focusTarget?focusIndex:-1;},
    setMode(value){mode=value==='galaxy'?'galaxy':'tree';mixTarget=mode==='galaxy'?1:0;},
    rotateImpulse(value){velocity=clamp(value,-3.8,3.8);},
    setScale(value){scaleTarget=clamp(value,.65,1.65);},
    focus(index){if(!photos[index])return false;focusIndex=index;focusTarget=1;velocity*=.25;return true;},
    blur(){focusTarget=0;},
    reset(){scaleTarget=1;velocity=0;root.rotation.y=0;},
    unlockStar(){starUnlocked=true;},
    zoomStar(value=true){starZoomTarget=value?1:0;},
    pick,dispatchPick,
    pause(value){paused=value;cancelAnimationFrame(raf);if(!paused&&!destroyed){last=performance.now();raf=requestAnimationFrame(animate);}},
    getStats(){return{...stats,mode,scale:scaleTarget,focused:focusTarget?focusIndex:-1,star:project(star),photos:photos.map((p,i)=>({index:i,loaded:p.loaded,...project(p.group)})),mix,velocity};},
    destroy(){if(destroyed)return;destroyed=true;abort.abort();clearTimeout(lazyTimer);cancelAnimationFrame(raf);observer.disconnect();renderer.domElement.removeEventListener('webglcontextlost',contextLost);renderer.domElement.removeEventListener('webglcontextrestored',contextRestored);
      const geometries=new Set(),materials=new Set(),textures=new Set();scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{materials.add(m);if(m.map)textures.add(m.map);});});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());renderer.dispose();renderer.domElement.remove();}
  };
  last=performance.now();raf=requestAnimationFrame(animate);return api;
}
