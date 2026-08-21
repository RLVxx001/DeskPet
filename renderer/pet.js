import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

const canvas = document.getElementById('view')
const statusEl = document.getElementById('status')
const api = window.deskPet

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false
})
renderer.setClearColor(0x000000, 0)
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 40)
camera.position.set(0, 0.9, 4.2)
camera.lookAt(0, 0.9, 0)
scene.add(camera)

scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 1.05))
const keyLight = new THREE.DirectionalLight(0xffffff, Math.PI)
keyLight.position.set(0.4, 1.6, 1.1)
scene.add(keyLight)

const lookAtTarget = new THREE.Object3D()
camera.add(lookAtTarget)

const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.34, 40),
  new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.18,
    depthWrite: false
  })
)
shadow.rotation.x = -Math.PI / 2
shadow.position.y = 0.012
scene.add(shadow)

const clock = new THREE.Clock()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const lookDesired = new THREE.Vector3()
const box = new THREE.Box3()
const boxSize = new THREE.Vector3()
const boxCenter = new THREE.Vector3()
const projected = new THREE.Vector3()

let vrm = null
let hovering = false
let dragging = false
let pressX = 0
let pressY = 0
let lastScreenX = 0
let lastScreenY = 0
let blinkDelay = 1.8
let blinkT = -1
let doubleBlink = false
let time = 0
let hasPointerInside = false
let mode = 'idle'
let walkDir = -1
let action = null
let facing = 0
let demoQueue = []
let demoWait = 0
let happy = 0

const ACTION_TIME = {
  wave: 1.25,
  nod: 1.05,
  bow: 1.7,
  jump: 0.78,
  clap: 1.45,
  stretch: 2.15,
  think: 2.2,
  dance: 3.4,
  spin: 1.55
}

const setStatus = (text) => {
  if (statusEl) statusEl.textContent = text
}

const resize = () => {
  const width = Math.max(1, canvas.clientWidth)
  const height = Math.max(1, canvas.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

const toArrayBuffer = (data) => {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  if (data?.type === 'Buffer' && Array.isArray(data.data)) {
    return new Uint8Array(data.data).buffer
  }
  throw new Error('无法读取模型数据')
}

const bone = (name) => vrm?.humanoid?.getNormalizedBoneNode(name) ?? null

const setBone = (name, x, y, z) => {
  const node = bone(name)
  if (node) node.rotation.set(x, y, z)
}

const applyIdlePose = (t, lift) => {
  const breath = Math.sin(t * 1.55)
  const sway = Math.sin(t * 0.55)
  setBone('hips', 0.02, sway * 0.045, sway * 0.012)
  setBone('spine', 0.04 + breath * 0.018, sway * 0.02, 0)
  setBone('chest', 0.03 + breath * 0.03, 0, 0)
  setBone('upperChest', breath * 0.012, 0, 0)
  setBone('leftUpperArm', 0.06, 0.16, -1.22 + breath * 0.03)
  setBone('rightUpperArm', 0.06, -0.16, 1.22 - breath * 0.03)
  setBone('leftLowerArm', 0.12, -0.22, 0.08)
  setBone('rightLowerArm', 0.12, 0.22, -0.08)
  setBone('leftHand', 0.05, 0.04, 0.06)
  setBone('rightHand', 0.05, -0.04, -0.06)
  setBone('leftUpperLeg', 0.02, 0, -0.04 + sway * 0.02)
  setBone('rightUpperLeg', 0.02, 0, 0.04 - sway * 0.02)
  setBone('leftLowerLeg', 0.04, 0, 0)
  setBone('rightLowerLeg', 0.04, 0, 0)
  if (vrm) vrm.scene.position.y = lift * 0.05
  shadow.scale.setScalar(1 - lift * 0.18)
  shadow.material.opacity = 0.18 * (1 - lift * 0.45)
}

const applyWalkPose = (t) => {
  const step = t * 7.2
  const swing = Math.sin(step)
  const bounce = Math.abs(Math.sin(step)) * 0.02
  setBone('hips', 0.05, 0, swing * 0.05)
  setBone('spine', 0.06, 0, 0)
  setBone('chest', 0.04, 0, 0)
  setBone('leftUpperLeg', swing * 0.55, 0, -0.03)
  setBone('rightUpperLeg', -swing * 0.55, 0, 0.03)
  setBone('leftLowerLeg', Math.max(0, -swing) * 0.55, 0, 0)
  setBone('rightLowerLeg', Math.max(0, swing) * 0.55, 0, 0)
  setBone('leftUpperArm', 0.08, 0.12, -1.18 - swing * 0.28)
  setBone('rightUpperArm', 0.08, -0.12, 1.18 - swing * 0.28)
  setBone('leftLowerArm', 0.18, -0.2, 0.08)
  setBone('rightLowerArm', 0.18, 0.2, -0.08)
  if (vrm) vrm.scene.position.y = bounce
  shadow.scale.setScalar(0.92)
  shadow.material.opacity = 0.14
}

const applySitPose = (t) => {
  const breath = Math.sin(t * 1.4) * 0.02
  setBone('hips', 0.18, 0, 0)
  setBone('spine', 0.12 + breath, 0, 0)
  setBone('chest', 0.08, 0, 0)
  setBone('leftUpperLeg', 1.15, 0, -0.06)
  setBone('rightUpperLeg', 1.15, 0, 0.06)
  setBone('leftLowerLeg', -1.25, 0, 0)
  setBone('rightLowerLeg', -1.25, 0, 0)
  setBone('leftUpperArm', 0.2, 0.25, -1.05)
  setBone('rightUpperArm', 0.2, -0.25, 1.05)
  setBone('leftLowerArm', 0.35, -0.35, 0.1)
  setBone('rightLowerArm', 0.35, 0.35, -0.1)
  if (vrm) vrm.scene.position.y = -0.12
  shadow.scale.setScalar(0.78)
}

const applySleepPose = (t) => {
  applySitPose(t)
  setBone('spine', 0.42, 0.12, 0)
  setBone('chest', 0.28, 0.08, 0)
  setBone('leftUpperArm', 0.4, 0.35, -0.7)
  setBone('rightUpperArm', 0.55, -0.2, 0.55)
  if (vrm) vrm.scene.position.y = -0.14
}

const applyActionPose = (name, p) => {
  const ease = Math.sin(Math.min(Math.max(p, 0), 1) * Math.PI)
  if (name === 'wave') {
    const swing = Math.sin(p * Math.PI * 6) * 0.5 * ease
    setBone('rightUpperArm', -0.35 * ease, -0.12, 1.22 - 1.55 * ease)
    setBone('rightLowerArm', 0.12, 0.15 + swing, -0.08)
    happy = 0.5 * ease
    return
  }
  if (name === 'nod') {
    setBone('spine', 0.04 + Math.sin(p * Math.PI * 3) * 0.18, 0, 0)
    setBone('chest', 0.03 + Math.sin(p * Math.PI * 3) * 0.12, 0, 0)
    return
  }
  if (name === 'bow') {
    setBone('hips', 0.12 * ease, 0, 0)
    setBone('spine', 0.08 + 0.55 * ease, 0, 0)
    setBone('chest', 0.06 + 0.4 * ease, 0, 0)
    setBone('leftUpperArm', 0.2 * ease, 0.1, -1.22)
    setBone('rightUpperArm', 0.2 * ease, -0.1, 1.22)
    return
  }
  if (name === 'jump') {
    const lift = Math.sin(p * Math.PI)
    setBone('leftUpperLeg', -0.35 * lift, 0, -0.04)
    setBone('rightUpperLeg', -0.35 * lift, 0, 0.04)
    setBone('leftLowerLeg', 0.55 * lift, 0, 0)
    setBone('rightLowerLeg', 0.55 * lift, 0, 0)
    setBone('leftUpperArm', -0.4 * lift, 0.1, -1.0)
    setBone('rightUpperArm', -0.4 * lift, -0.1, 1.0)
    if (vrm) vrm.scene.position.y = 0.22 * lift
    shadow.scale.setScalar(1 - 0.35 * lift)
    return
  }
  if (name === 'clap') {
    const clap = (Math.sin(p * Math.PI * 8) * 0.5 + 0.5) * ease
    setBone('leftUpperArm', 0.35 * ease, 0.55 * ease, -0.55)
    setBone('rightUpperArm', 0.35 * ease, -0.55 * ease, 0.55)
    setBone('leftLowerArm', 0.2, -0.15 - clap * 0.35, 0.15)
    setBone('rightLowerArm', 0.2, 0.15 + clap * 0.35, -0.15)
    happy = 0.4 * ease
    return
  }
  if (name === 'stretch') {
    setBone('leftUpperArm', -1.35 * ease, 0.15, -0.35)
    setBone('rightUpperArm', -1.35 * ease, -0.15, 0.35)
    setBone('leftLowerArm', 0.15, -0.1, 0)
    setBone('rightLowerArm', 0.15, 0.1, 0)
    setBone('spine', -0.08 * ease, 0, 0)
    setBone('chest', -0.06 * ease, 0, 0)
    if (vrm) vrm.scene.position.y = 0.03 * ease
    return
  }
  if (name === 'think') {
    setBone('rightUpperArm', 0.15, -0.55 * ease, 0.25)
    setBone('rightLowerArm', 0.9 * ease, 0.55 * ease, -0.2)
    setBone('spine', 0.08, -0.08 * ease, 0)
    setBone('chest', 0.05, -0.06 * ease, 0)
    return
  }
  if (name === 'dance') {
    const sway = Math.sin(p * Math.PI * 4)
    const bounce = Math.abs(Math.sin(p * Math.PI * 8))
    setBone('hips', 0.08, sway * 0.22, sway * 0.08)
    setBone('spine', 0.08, sway * 0.12, 0)
    setBone('leftUpperArm', -0.7 + sway * 0.4, 0.2, -0.7)
    setBone('rightUpperArm', -0.7 - sway * 0.4, -0.2, 0.7)
    setBone('leftUpperLeg', bounce * 0.25, 0, -0.08)
    setBone('rightUpperLeg', (1 - bounce) * 0.25, 0, 0.08)
    if (vrm) vrm.scene.position.y = bounce * 0.04
    happy = 0.55
    return
  }
  if (name === 'spin') {
    setBone('leftUpperArm', 0.1, 0.2, -1.05)
    setBone('rightUpperArm', 0.1, -0.2, 1.05)
    if (vrm) vrm.scene.position.y = 0.02
  }
}

const beginAction = (name) => {
  if (name === 'idle') {
    mode = 'idle'
    action = null
    happy = 0
    return
  }
  if (name === 'walk' || name === 'sit' || name === 'sleep') {
    mode = name
    action = null
    happy = 0
    return
  }
  if (name === 'demo') {
    demoQueue = [
      ['wave', 1.4],
      ['nod', 1.15],
      ['bow', 1.8],
      ['jump', 1.0],
      ['clap', 1.55],
      ['stretch', 2.25],
      ['think', 2.25],
      ['dance', 3.5],
      ['spin', 1.65],
      ['sit', 2.1],
      ['sleep', 2.3],
      ['idle', 0.3]
    ]
    const first = demoQueue.shift()
    beginAction(first[0])
    demoWait = first[1]
    return
  }
  mode = 'idle'
  action = { name, t: 0, duration: ACTION_TIME[name] || 1.2 }
}

const framePet = () => {
  if (!vrm) return
  applyIdlePose(0, 0)
  vrm.update(0)
  box.setFromObject(vrm.scene)
  box.getSize(boxSize)
  box.getCenter(boxCenter)

  const bottom = box.min.y - boxSize.y * 0.03
  const top = box.max.y + boxSize.y * 0.1
  const height = Math.max(top - bottom, 0.8)
  const width = Math.max(boxSize.x * 1.25, 0.4)
  const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5)
  const distH = (height / 2) / Math.tan(halfFov)
  const distW = (width / 2) / Math.tan(halfFov) / Math.max(camera.aspect, 0.1)
  const dist = Math.max(distH, distW, 1.8) * 1.04
  const lookY = (top + bottom) / 2

  camera.near = 0.1
  camera.far = Math.max(20, dist + 8)
  camera.position.set(0, lookY, dist)
  camera.lookAt(0, lookY, 0)
  camera.updateProjectionMatrix()
  shadow.position.set(0, box.min.y + 0.012, 0)
}

const updateBlink = (dt) => {
  const expressions = vrm?.expressionManager
  if (!expressions) return

  if (blinkT >= 0) {
    blinkT += dt
    const duration = 0.14
    const phase = Math.min(blinkT / duration, 1)
    const value = phase < 0.5 ? phase * 2 : (1 - phase) * 2
    expressions.setValue('blink', value)
    if (phase >= 1) {
      expressions.setValue('blink', 0)
      if (doubleBlink) {
        doubleBlink = false
        blinkT = 0
      } else {
        blinkT = -1
        blinkDelay = 2.2 + Math.random() * 3.6
      }
    }
    return
  }

  blinkDelay -= dt
  if (blinkDelay <= 0) {
    blinkT = 0
    doubleBlink = Math.random() < 0.18
  }
}

const projectBoxToScreen = () => {
  if (!vrm) return null
  box.setFromObject(vrm.scene)
  box.getSize(boxSize)
  const minX = box.min.x + boxSize.x * 0.12
  const maxX = box.max.x - boxSize.x * 0.12
  const minY = box.min.y
  const maxY = box.max.y
  const z = (box.min.z + box.max.z) * 0.5
  const corners = [
    [minX, minY, z],
    [maxX, minY, z],
    [minX, maxY, z],
    [maxX, maxY, z]
  ]
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const [x, y, zz] of corners) {
    projected.set(x, y, zz).project(camera)
    const sx = (projected.x * 0.5 + 0.5) * canvas.clientWidth
    const sy = (-projected.y * 0.5 + 0.5) * canvas.clientHeight
    left = Math.min(left, sx)
    right = Math.max(right, sx)
    top = Math.min(top, sy)
    bottom = Math.max(bottom, sy)
  }
  return { left, right, top, bottom }
}

const isOverPet = (clientX, clientY) => {
  if (!vrm) return false
  pointer.x = (clientX / canvas.clientWidth) * 2 - 1
  pointer.y = -(clientY / canvas.clientHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  if (raycaster.intersectObject(vrm.scene, true).length > 0) return true

  const bounds = projectBoxToScreen()
  if (!bounds) return false
  return clientX >= bounds.left - 10 &&
    clientX <= bounds.right + 10 &&
    clientY >= bounds.top - 8 &&
    clientY <= bounds.bottom + 8
}

const syncMouseIgnore = () => {
  if (!api) return
  api.setIgnoreMouse(!(hovering || dragging))
}

const updateLookTarget = (dt, clientX, clientY) => {
  if (mode === 'walk') {
    lookDesired.set(walkDir * 1.4, 0.05, 0)
  } else if (mode === 'sleep') {
    lookDesired.set(0.4, -1.6, 0)
  } else if (mode === 'sit') {
    lookDesired.set(0.15, -0.2, 0)
  } else if (hasPointerInside && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    lookDesired.set(
      4.2 * ((clientX - canvas.clientWidth * 0.5) / canvas.clientHeight),
      -3.6 * ((clientY - canvas.clientHeight * 0.42) / canvas.clientHeight),
      0
    )
  } else {
    lookDesired.set(Math.sin(time * 0.35) * 0.35, Math.sin(time * 0.22) * 0.18, 0)
  }
  lookAtTarget.position.lerp(lookDesired, 1 - Math.exp(-5 * dt))
}

let lastPointerX = canvas.clientWidth * 0.5
let lastPointerY = canvas.clientHeight * 0.4

const animate = () => {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 0.05)
  time += dt
  const lift = dragging ? 1 : 0

  if (vrm) {
    if (mode === 'walk') applyWalkPose(time)
    else if (mode === 'sit') applySitPose(time)
    else if (mode === 'sleep') applySleepPose(time)
    else applyIdlePose(time, lift)

    if (action) {
      action.t += dt
      applyActionPose(action.name, action.t / action.duration)
      if (action.t >= action.duration) {
        action = null
        happy = 0
      }
    }

    if (demoWait > 0) {
      demoWait -= dt
      if (demoWait <= 0 && demoQueue.length) {
        const next = demoQueue.shift()
        beginAction(next[0])
        demoWait = next[0] === 'idle' ? 0 : next[1]
      }
    }

    if (action?.name === 'spin') facing += dt * 7.2
    else {
      const wantFace = mode === 'walk' ? (walkDir > 0 ? -0.9 : 0.9) : 0
      facing += (wantFace - facing) * (1 - Math.exp(-6 * dt))
    }
    vrm.scene.rotation.y = facing
    vrm.expressionManager?.setValue('happy', happy)
    updateBlink(dt)
    updateLookTarget(dt, lastPointerX, lastPointerY)
    vrm.update(dt)
  }

  renderer.render(scene, camera)
}

const disposeVrm = () => {
  if (!vrm) return
  scene.remove(vrm.scene)
  vrm.scene.traverse((obj) => {
    obj.geometry?.dispose?.()
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const material of materials) material?.dispose?.()
  })
  vrm = null
}

const loadVRM = async () => {
  if (!api) throw new Error('桌宠接口不可用，请用应用窗口打开')
  const buffer = toArrayBuffer(await api.loadModel())
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))

  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject)
  })

  const next = gltf.userData.vrm
  if (!next) throw new Error('这个文件不是可用的 VRM 角色')

  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  if (VRMUtils.combineMorphs) VRMUtils.combineMorphs(next)
  if (VRMUtils.rotateVRM0) VRMUtils.rotateVRM0(next)

  next.scene.traverse((obj) => {
    obj.frustumCulled = false
  })

  disposeVrm()
  scene.add(next.scene)
  next.lookAt.target = lookAtTarget
  vrm = next
  facing = 0
  mode = 'idle'
  action = null
  resize()
  framePet()
}

canvas.addEventListener('pointermove', (event) => {
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  hasPointerInside = true
  hovering = isOverPet(event.clientX, event.clientY)
  document.body.classList.toggle('is-hovering', hovering)

  if (event.buttons === 1 && !dragging) {
    const moved = Math.hypot(event.clientX - pressX, event.clientY - pressY)
    if (moved > 5) {
      dragging = true
      document.body.classList.add('is-dragging')
    }
  }

  document.body.classList.toggle('is-dragging', dragging)
  syncMouseIgnore()
  if (!dragging) return
  api?.moveBy(event.screenX - lastScreenX, event.screenY - lastScreenY)
  lastScreenX = event.screenX
  lastScreenY = event.screenY
})

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !isOverPet(event.clientX, event.clientY)) return
  hovering = true
  pressX = event.clientX
  pressY = event.clientY
  lastScreenX = event.screenX
  lastScreenY = event.screenY
  canvas.setPointerCapture(event.pointerId)
  syncMouseIgnore()
})

canvas.addEventListener('pointerup', (event) => {
  const wasDragging = dragging
  dragging = false
  document.body.classList.remove('is-dragging')
  hovering = isOverPet(event.clientX, event.clientY)
  syncMouseIgnore()
  if (!wasDragging && event.button === 0 && isOverPet(event.clientX, event.clientY)) {
    beginAction('wave')
    api?.clicked()
  }
})

canvas.addEventListener('pointerleave', () => {
  hasPointerInside = false
  if (!dragging) {
    hovering = false
    document.body.classList.remove('is-hovering')
    syncMouseIgnore()
  }
})

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (isOverPet(event.clientX, event.clientY)) api?.showMenu()
})

canvas.addEventListener('dblclick', (event) => {
  if (isOverPet(event.clientX, event.clientY)) api?.openChat()
})

api?.onMode((payload) => {
  if (!payload?.mode) return
  if (payload.dir) walkDir = payload.dir
  beginAction(payload.mode)
})

api?.onReloadModel(() => {
  loadVRM()
    .then(() => {
      document.body.classList.add('is-ready')
      setStatus('')
      beginAction('wave')
    })
    .catch((error) => {
      console.error(error)
      setStatus(error?.message || '角色加载失败')
    })
})

window.addEventListener('resize', () => {
  resize()
  framePet()
})
resize()
animate()

loadVRM()
  .then(() => {
    document.body.classList.add('is-ready')
    setStatus('')
  })
  .catch((error) => {
    console.error(error)
    setStatus(error?.message || '角色加载失败')
  })
