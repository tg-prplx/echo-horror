const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,timeout:30000,args:['--autoplay-policy=no-user-gesture-required']});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('echo.quality','low'));
    await page.goto(process.env.GAME_URL||'http://127.0.0.1:4173/',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(()=>window.__game&&document.querySelector('#start').dataset.screen==='headphones',{timeout:90000});
    await page.locator('#enter-menu').click({force:true});
    await page.locator('#play').click({force:true});
    await page.waitForFunction(()=>document.querySelector('#start').dataset.screen==='briefing');
    await page.locator('#begin-session').click({force:true});
    await page.waitForFunction(()=>window.__game.game.state==='play'&&!!document.pointerLockElement);
    const result=await page.evaluate(()=>{
      const g=window.__game,p=g.player,gain=.0012*Number(document.querySelector('#sens').value);
      window.__freeze=true;window.requestAnimationFrame=()=>0;g.monster.despawn();
      function move(dx,dy=0,clientX=640,clientY=400){
        const event=new MouseEvent('mousemove',{clientX,clientY,bubbles:true});
        Object.defineProperties(event,{movementX:{value:dx},movementY:{value:dy}});window.dispatchEvent(event);
      }
      function inspect(chapter,home,yaw){
        const results=[];
        for(const fps of [20,30,60,144]){
          p.reset(home,yaw);move(0);let expected=p.yaw,maxAngle=0;
          const previous=g.camera.quaternion.clone();
          for(let n=0;n<fps*3;n++){
            p.keys.clear();p.keys.add(n%fps<fps/2?'KeyW':'KeyS');
            if(n<fps*1.5)p.keys.add('ShiftLeft');
            if(n%17===0){move(Math.PI/gain);if(p.yaw!==expected)throw new Error('Warp packet turned the camera');}
            const dx=n%2?2:-2;move(dx);expected-=dx*gain;g.tick(1,1/fps);
            const angle=previous.angleTo(g.camera.quaternion);maxAngle=Math.max(maxAngle,angle);previous.copy(g.camera.quaternion);
            if(Math.abs(p.yaw-expected)>1e-9||angle>.08)throw new Error(`Camera snapped in chapter ${chapter} at ${fps} fps`);
          }
          p.keys.clear();results.push({fps,maxFrameAngle:maxAngle});
        }
        return {chapter,results};
      }
      const hospital=inspect(1,{x:32,z:48},0);
      // Use the actual Chapter I ending to mount the original lift in Chapter II.
      p.reset({x:8.1,z:1.5},-Math.PI/2);g.game.flags.arrived=true;
      g.level.setDoor('lift',true);g.level.updateDoors(2);g.use(g.level.items.find(it=>it.type==='cab'));
      p.keys.add('KeyE');g.tick(100);p.keys.clear();
      if(!g.chapter.active)throw new Error('Could not enter the cave chapter');
      g.chapter.sequence.phase='explore';g.chapter.sequence.opening=1;g.chapter.applyState();g.chapter.spawned=true;
      const cave=inspect(2,{x:31.5,z:20},Math.PI/2);
      const before=p.yaw;
      for(let n=0;n<60;n++)move(50);
      if(Math.abs(p.yaw-(before-3000*gain))>1e-9)throw new Error('Deliberate quick turns were slowed');
      return {nativePointerLock:true,hospital,cave,quickTurns:true};
    });
    console.log('movement',JSON.stringify(result));
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>window.__game.game.state==='paused');
    await page.locator('#resume').click({force:true});
    await page.waitForFunction(()=>!!document.pointerLockElement);
    const reacquire=await page.evaluate(()=>{
      const g=window.__game,p=g.player,before=p.yaw;
      const event=new MouseEvent('mousemove');Object.defineProperties(event,{movementX:{value:4000},movementY:{value:-4000}});window.dispatchEvent(event);
      if(p.yaw!==before)throw new Error('Reacquiring pointer lock snapped the camera');
      return true;
    });
    await page.evaluate(()=>document.exitPointerLock());
    await page.waitForFunction(()=>window.__game.game.state==='paused');
    const fallback=await page.evaluate(()=>{
      const g=window.__game,p=g.player,canvas=document.querySelector('canvas');
      g.game.state='play';document.querySelector('#pause').classList.add('hidden');
      canvas.requestPointerLock=()=>Promise.reject(new Error('Simulated unsupported pointer lock'));
      const before=p.yaw,gain=.0012*Number(document.querySelector('#sens').value);
      canvas.dispatchEvent(new MouseEvent('mousedown',{clientX:100,clientY:100,button:0,bubbles:true}));
      const event=new MouseEvent('mousemove',{clientX:110,clientY:100,bubbles:true});
      Object.defineProperties(event,{movementX:{value:4000},movementY:{value:4000}});window.dispatchEvent(event);
      if(Math.abs(p.yaw-(before-10*gain))>1e-9)throw new Error('Unlocked drag used movementX instead of its own origin');
      window.dispatchEvent(new Event('blur'));
      const after=p.yaw;window.dispatchEvent(new MouseEvent('mousemove',{clientX:1000,clientY:400}));
      if(p.yaw!==after)throw new Error('Blur did not release drag look');
      return true;
    });
    assert.deepEqual(errors,[]);
    console.log('input',JSON.stringify({reacquire,fallback,errors}));
    console.log('Desktop mouse/trackpad look, both chapters, quick turns and lock transitions passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
