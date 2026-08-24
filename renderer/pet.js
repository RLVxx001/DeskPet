import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation'

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
let baseYaw = 0
let demoQueue = []
let demoWait = 0
let happy = 0
let playful = 0
let plotting = 0
let surprised = 0

const ACTION_TIME = {
  wave: 1.4,
  nod: 0.95,
  bow: 1.35,
  jump: 0.7,
  clap: 1.2,
  stretch: 1.7,
  think: 2.0,
  dance: 2.8,
  spin: 1.45
}

const VRMA_MAP = {
  idle: { file: 'LookAround', loop: true },
  sit: { file: 'Relax', loop: true },
  sleep: { file: 'Sleepy', loop: true },
  wave: { file: 'Goodbye', loop: false },
  clap: { file: 'Clapping', loop: false },
  jump: { file: 'Jump', loop: false },
  think: { file: 'Thinking', loop: false },
  stretch: { file: 'Surprised', loop: false },
  dance: { file: 'Clapping', loop: false }
}

let vrmaSource = {}
let mixer = null
let currentClipAction = null
let usingVrma = false
let vrmaName = ''

const parseVrma = (buffer) => new Promise((resolve, reject) => {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  loader.parse(toArrayBuffer(buffer), '', resolve, reject)
})

const loadVrmaLibrary = async () => {
  if (Object.keys(vrmaSource).length || !api?.loadAnimations) return
  const files = await api.loadAnimations()
  for (const [name, data] of Object.entries(files || {})) {
    try {
      const gltf = await parseVrma(data)
      const anim = gltf.userData?.vrmAnimations?.[0]
      if (anim) vrmaSource[name] = anim
    } catch (error) {
      console.error('[vrma]', name, error)
    }
  }
}

const stopVrma = () => {
  if (currentClipAction) {
    currentClipAction.fadeOut(0.15)
    currentClipAction.stop()
  }
  currentClipAction = null
  usingVrma = false
  vrmaName = ''
  mixer?.stopAllAction()
}

const playVrma = (name) => {
  const spec = VRMA_MAP[name]
  const source = spec && vrmaSource[spec.file]
  if (!spec || !source || !vrm || !mixer) return false
  let clip
  try {
    clip = createVRMAnimationClip(source, vrm)
  } catch (error) {
    console.error('[vrma-clip]', name, error)
    return false
  }
  const next = mixer.clipAction(clip)
  next.reset()
  next.enabled = true
  next.setLoop(spec.loop ? THREE.LoopRepeat : THREE.LoopOnce, spec.loop ? Infinity : 1)
  next.clampWhenFinished = !spec.loop
  if (currentClipAction && currentClipAction !== next) currentClipAction.fadeOut(0.2)
  next.fadeIn(0.2).play()
  currentClipAction = next
  usingVrma = true
  vrmaName = name
  if (!spec.loop) {
    const onFinished = (event) => {
      if (event.action !== next) return
      mixer.removeEventListener('finished', onFinished)
      if (vrmaName === name && mode !== 'walk') beginAction('idle')
    }
    mixer.addEventListener('finished', onFinished)
  }
  return true
}

const lockRootMotion = () => {
  const hips = bone('hips')
  if (hips) {
    hips.position.x = 0
    hips.position.z = 0
  }
  if (vrm) {
    vrm.scene.position.x = 0
    vrm.scene.position.z = 0
  }
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

let hangLeft = [0, 0, 1.35]
let hangRight = [0, 0, -1.35]
const handWorld = new THREE.Vector3()

const bone = (name) => (
  vrm?.humanoid?.getNormalizedBoneNode(name) ??
  vrm?.humanoid?.getRawBoneNode?.(name) ??
  null
)

const setBone = (name, x, y, z) => {
  const node = bone(name)
  if (node) node.rotation.set(x, y, z)
}

const boneWorldY = (name) => {
  const node = bone(name)
  if (!node) return 0
  node.getWorldPosition(handWorld)
  return handWorld.y
}

const measureHandsY = () => {
  vrm?.update(0)
  return (boneWorldY('leftHand') + boneWorldY('rightHand')) * 0.5
}

const calibrateArms = () => {
  if (!bone('leftUpperArm') || !bone('rightUpperArm')) return
  const candidates = [
    [[0, 0, -1.35], [0, 0, 1.35]],
    [[0, 0, 1.35], [0, 0, -1.35]],
    [[1.35, 0, 0], [1.35, 0, 0]],
    [[-1.35, 0, 0], [-1.35, 0, 0]],
    [[0, 1.35, 0], [0, -1.35, 0]],
    [[0, -1.35, 0], [0, 1.35, 0]]
  ]
  let bestY = Infinity
  for (const [left, right] of candidates) {
    setBone('leftUpperArm', left[0], left[1], left[2])
    setBone('rightUpperArm', right[0], right[1], right[2])
    setBone('leftLowerArm', 0, 0, 0)
    setBone('rightLowerArm', 0, 0, 0)
    const y = measureHandsY()
    if (y < bestY) {
      bestY = y
      hangLeft = left
      hangRight = right
    }
  }
  applyArmRest(0)
}

const lerpArm = (from, toward, t) => ([
  from[0] + (toward[0] - from[0]) * t,
  from[1] + (toward[1] - from[1]) * t,
  from[2] + (toward[2] - from[2]) * t
])

const EXPR_ALIASES = {
  blink: ['blink', 'Blink'],
  happy: ['happy', 'Joy', 'Smile'],
  playful: ['Playful', 'Fun', 'relaxed'],
  plotting: ['Plotting', 'Gloating', 'Puzzled'],
  surprised: ['Surprised'],
  confused: ['Confused', 'Puzzled']
}

const setExpr = (key, value) => {
  const expressions = vrm?.expressionManager
  if (!expressions) return
  const amount = Math.min(Math.max(value, 0), 1)
  for (const name of EXPR_ALIASES[key] || [key]) {
    try {
      expressions.setValue(name, amount)
    } catch {}
  }
}

const resetExprs = () => {
  setExpr('happy', 0)
  setExpr('playful', 0)
  setExpr('plotting', 0)
  setExpr('surprised', 0)
  setExpr('confused', 0)
}

const setRootY = (y) => {
  if (!vrm) return
  vrm.scene.position.y = Math.min(Math.max(y, -0.08), 0.07)
}

const applyArmRest = (t = 0) => {
  const breath = Math.sin(t * 1.4) * 0.02
  setBone('leftUpperArm', hangLeft[0] + breath, hangLeft[1], hangLeft[2])
  setBone('rightUpperArm', hangRight[0] + breath, hangRight[1], hangRight[2])
  setBone('leftLowerArm', 0.08, -0.06, 0.02)
  setBone('rightLowerArm', 0.08, 0.06, -0.02)
  setBone('leftHand', 0, 0, 0)
  setBone('rightHand', 0, 0, 0)
}

const applyIdlePose = (t, lift) => {
  const breath = Math.sin(t * 1.45)
  const sway = Math.sin(t * 0.48)
  setBone('hips', 0.02, sway * 0.03, 0)
  setBone('spine', 0.03 + breath * 0.016, sway * 0.015, 0)
  setBone('chest', 0.02 + breath * 0.02, 0, 0)
  setBone('upperChest', breath * 0.01, 0, 0)
  setBone('neck', 0.02, sway * 0.04, 0)
  setBone('head', 0.03, sway * 0.05, 0)
  applyArmRest(t)
  setBone('leftUpperLeg', 0.02, 0, -0.03 + sway * 0.015)
  setBone('rightUpperLeg', 0.02, 0, 0.03 - sway * 0.015)
  setBone('leftLowerLeg', 0.03, 0, 0)
  setBone('rightLowerLeg', 0.03, 0, 0)
  setRootY(lift * 0.03)
  shadow.scale.setScalar(1 - lift * 0.12)
  shadow.material.opacity = 0.18 * (1 - lift * 0.35)
  if (!action) {
    playful = 0.04
    happy = 0.03
  }
}

const applyWalkPose = (t) => {
  const step = t * 6.4
  const swing = Math.sin(step)
  const bounce = Math.abs(Math.sin(step))
  setBone('hips', 0.04, 0, swing * 0.03)
  setBone('spine', 0.05, 0, 0)
  setBone('chest', 0.03, 0, 0)
  setBone('neck', 0.02, 0, 0)
  setBone('head', 0.04, swing * 0.04, 0)
  setBone('leftUpperLeg', swing * 0.38, 0, -0.03)
  setBone('rightUpperLeg', -swing * 0.38, 0, 0.03)
  setBone('leftLowerLeg', Math.max(0, -swing) * 0.4, 0, 0)
  setBone('rightLowerLeg', Math.max(0, swing) * 0.4, 0, 0)
  const leftSwing = lerpArm(hangLeft, [0, 0, 0], 0.12 + swing * 0.1)
  const rightSwing = lerpArm(hangRight, [0, 0, 0], 0.12 - swing * 0.1)
  setBone('leftUpperArm', leftSwing[0], leftSwing[1], leftSwing[2])
  setBone('rightUpperArm', rightSwing[0], rightSwing[1], rightSwing[2])
  setBone('leftLowerArm', 0.12, -0.08, 0.03)
  setBone('rightLowerArm', 0.12, 0.08, -0.03)
  setRootY(bounce * 0.012)
  shadow.scale.setScalar(0.94)
  shadow.material.opacity = 0.15
}

const applySitPose = (t) => {
  const breath = Math.sin(t * 1.35) * 0.015
  setBone('hips', 0.12, 0, 0)
  setBone('spine', 0.08 + breath, 0, 0)
  setBone('chest', 0.05, 0, 0)
  setBone('neck', 0.04, 0.06, 0)
  setBone('head', 0.05, 0.08, 0)
  setBone('leftUpperLeg', 0.72, 0, -0.04)
  setBone('rightUpperLeg', 0.72, 0, 0.04)
  setBone('leftLowerLeg', -0.82, 0, 0)
  setBone('rightLowerLeg', -0.82, 0, 0)
  applyArmRest(t)
  setBone('leftLowerArm', 0.22, -0.16, 0.04)
  setBone('rightLowerArm', 0.22, 0.16, -0.04)
  setRootY(-0.06)
  shadow.scale.setScalar(0.82)
  happy = 0.06
}

const applySleepPose = (t) => {
  applySitPose(t)
  const snore = Math.sin(t * 1.05)
  setBone('spine', 0.22, 0.1, 0)
  setBone('chest', 0.14, 0.05, 0)
  setBone('neck', 0.16, 0.22, 0.06)
  setBone('head', 0.2 + snore * 0.02, 0.28, 0.05)
  applyArmRest(t)
  setBone('leftLowerArm', 0.28, -0.14, 0.04)
  setBone('rightLowerArm', 0.32, 0.12, -0.03)
  setRootY(-0.07)
  happy = 0.02
  playful = 0
}

const applyActionPose = (name, p) => {
  const clamp = Math.min(Math.max(p, 0), 1)
  const ease = Math.sin(clamp * Math.PI)
  if (name === 'wave') {
    const flap = Math.sin(p * Math.PI * 5) * 0.22 * ease
    applyArmRest()
    const raised = lerpArm(hangRight, [0, 0, 0], 0.72 * ease)
    setBone('neck', 0.03, 0.08 * ease, 0)
    setBone('head', 0.04, 0.1 * ease, 0)
    setBone('rightUpperArm', raised[0], raised[1], raised[2])
    setBone('rightLowerArm', 0.1, 0.06 + flap, -0.04)
    happy = 0.35 * ease
    playful = 0.25 * ease
    return
  }
  if (name === 'nod') {
    const dip = Math.sin(p * Math.PI * 3)
    applyArmRest()
    setBone('neck', 0.03 + dip * 0.16, 0, 0)
    setBone('head', 0.04 + dip * 0.2, 0, 0)
    happy = 0.16 * ease
    return
  }
  if (name === 'bow') {
    applyArmRest()
    setBone('hips', 0.08 * ease, 0, 0)
    setBone('spine', 0.04 + 0.28 * ease, 0, 0)
    setBone('chest', 0.03 + 0.18 * ease, 0, 0)
    setBone('neck', 0.06 + 0.12 * ease, 0, 0)
    setBone('head', 0.08 + 0.12 * ease, 0, 0)
    return
  }
  if (name === 'jump') {
    const lift = Math.sin(clamp * Math.PI)
    applyArmRest()
    setBone('leftUpperLeg', -0.18 * lift, 0, -0.03)
    setBone('rightUpperLeg', -0.18 * lift, 0, 0.03)
    setBone('leftLowerLeg', 0.28 * lift, 0, 0)
    setBone('rightLowerLeg', 0.28 * lift, 0, 0)
    setRootY(0.04 * lift)
    shadow.scale.setScalar(1 - 0.12 * lift)
    happy = 0.22 * lift
    return
  }
  if (name === 'clap') {
    const clap = (Math.sin(p * Math.PI * 7) * 0.5 + 0.5) * ease
    applyArmRest()
    const left = lerpArm(hangLeft, [0.15, 0.25, 0], 0.55 * ease)
    const right = lerpArm(hangRight, [0.15, -0.25, 0], 0.55 * ease)
    setBone('leftUpperArm', left[0], left[1], left[2])
    setBone('rightUpperArm', right[0], right[1], right[2])
    setBone('leftLowerArm', 0.16, -0.08 - clap * 0.16, 0.04)
    setBone('rightLowerArm', 0.16, 0.08 + clap * 0.16, -0.04)
    happy = 0.28 * ease
    playful = 0.2 * ease
    return
  }
  if (name === 'stretch') {
    applyArmRest()
    const left = lerpArm(hangLeft, [0, 0, 0], 0.45 * ease)
    const right = lerpArm(hangRight, [0, 0, 0], 0.45 * ease)
    setBone('leftUpperArm', left[0], left[1], left[2])
    setBone('rightUpperArm', right[0], right[1], right[2])
    setBone('spine', -0.05 * ease, 0, 0)
    setBone('chest', -0.04 * ease, 0, 0)
    setBone('neck', -0.04 * ease, 0, 0)
    setRootY(0.015 * ease)
    return
  }
  if (name === 'think') {
    applyArmRest()
    const raised = lerpArm(hangRight, [0.2, -0.2, 0], 0.7 * ease)
    setBone('spine', 0.05, -0.05 * ease, 0)
    setBone('neck', 0.06, -0.1 * ease, 0)
    setBone('head', 0.08, -0.16 * ease, 0.04)
    setBone('rightUpperArm', raised[0], raised[1], raised[2])
    setBone('rightLowerArm', 0.55 * ease, 0.28 * ease, -0.06)
    plotting = 0.45 * ease
    return
  }
  if (name === 'dance') {
    const sway = Math.sin(p * Math.PI * 3.2)
    const step = Math.sin(p * Math.PI * 6.4)
    applyArmRest()
    const left = lerpArm(hangLeft, [0, 0, 0], 0.12 + step * 0.08)
    const right = lerpArm(hangRight, [0, 0, 0], 0.12 - step * 0.08)
    setBone('hips', 0.04, sway * 0.12, sway * 0.04)
    setBone('spine', 0.05, sway * 0.08, 0)
    setBone('chest', 0.03, sway * 0.05, 0)
    setBone('head', 0.05, -sway * 0.1, 0)
    setBone('leftUpperArm', left[0], left[1], left[2])
    setBone('rightUpperArm', right[0], right[1], right[2])
    setBone('leftUpperLeg', Math.max(0, step) * 0.16, 0, -0.04)
    setBone('rightUpperLeg', Math.max(0, -step) * 0.16, 0, 0.04)
    setRootY(Math.abs(step) * 0.01)
    happy = 0.28
    playful = 0.22
    return
  }
  if (name === 'spin') {
    applyArmRest()
    const left = lerpArm(hangLeft, [0, 0, 0], 0.2 * ease)
    const right = lerpArm(hangRight, [0, 0, 0], 0.2 * ease)
    setBone('leftUpperArm', left[0], left[1], left[2])
    setBone('rightUpperArm', right[0], right[1], right[2])
    setBone('head', 0.05, 0, 0)
    setRootY(0.012 * ease)
    happy = 0.2 * ease
  }
}

const beginAction = (name) => {
  if (name === 'idle') {
    mode = 'idle'
    action = null
    happy = 0
    playful = 0
    plotting = 0
    surprised = 0
    if (!playVrma('idle')) stopVrma()
    return
  }
  if (name === 'walk') {
    mode = name
    action = null
    happy = 0
    playful = 0
    plotting = 0
    surprised = 0
    stopVrma()
    return
  }
  if (name === 'sit' || name === 'sleep') {
    mode = name
    action = null
    happy = 0
    playful = 0
    plotting = 0
    surprised = 0
    if (!playVrma(name)) stopVrma()
    return
  }
  if (name === 'demo') {
    demoQueue = [
      ['wave', 1.5],
      ['nod', 1.05],
      ['bow', 1.45],
      ['jump', 0.85],
      ['clap', 1.3],
      ['stretch', 1.8],
      ['think', 2.1],
      ['dance', 2.9],
      ['spin', 1.55],
      ['sit', 2.0],
      ['sleep', 2.2],
      ['idle', 0.3]
    ]
    const first = demoQueue.shift()
    beginAction(first[0])
    demoWait = first[1]
    return
  }
  mode = 'idle'
  if (playVrma(name)) {
    action = null
    return
  }
  action = { name, t: 0, duration: ACTION_TIME[name] || 1.2 }
}

const framePet = () => {
  if (!vrm) return
  applyIdlePose(0, 0)
  vrm.update(0)
  box.setFromObject(vrm.scene)
  box.getSize(boxSize)
  box.getCenter(boxCenter)

  const bottom = box.min.y - boxSize.y * 0.04
  const top = box.max.y + boxSize.y * 0.18
  const height = Math.max(top - bottom, 0.8)
  const width = Math.max(boxSize.x * 1.2, 0.4)
  const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5)
  const distH = (height / 2) / Math.tan(halfFov)
  const distW = (width / 2) / Math.tan(halfFov) / Math.max(camera.aspect, 0.1)
  const dist = Math.max(distH, distW, 1.8) * 1.12
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
    setExpr('blink', value)
    if (phase >= 1) {
      setExpr('blink', 0)
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
    if (usingVrma && mixer) {
      mixer.update(dt)
      lockRootMotion()
    } else if (mode === 'walk') applyWalkPose(time)
    else if (mode === 'sit') applySitPose(time)
    else if (mode === 'sleep') applySleepPose(time)
    else applyIdlePose(time, lift)

    if (!usingVrma && action) {
      action.t += dt
      applyActionPose(action.name, action.t / action.duration)
      if (action.t >= action.duration) {
        action = null
        happy = 0
        playful = 0
        plotting = 0
        surprised = 0
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
    vrm.scene.rotation.y = baseYaw + facing
    if (!usingVrma) {
      resetExprs()
      setExpr('happy', happy)
      setExpr('playful', playful)
      setExpr('plotting', plotting)
      setExpr('surprised', surprised)
    }
    updateBlink(dt)
    updateLookTarget(dt, lastPointerX, lastPointerY)
    vrm.update(dt)
  }

  renderer.render(scene, camera)
}

const disposeVrm = () => {
  stopVrma()
  mixer = null
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
  await loadVrmaLibrary()
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
  baseYaw = next.scene.rotation.y || 0

  next.scene.traverse((obj) => {
    obj.frustumCulled = false
  })

  if (next.lookAt) {
    const proxy = new VRMLookAtQuaternionProxy(next.lookAt)
    proxy.name = 'lookAtQuaternionProxy'
    next.scene.add(proxy)
  }

  disposeVrm()
  scene.add(next.scene)
  next.lookAt.target = lookAtTarget
  vrm = next
  mixer = new THREE.AnimationMixer(next.scene)
  facing = 0
  mode = 'idle'
  action = null
  happy = 0
  playful = 0
  plotting = 0
  surprised = 0
  calibrateArms()
  resize()
  framePet()
  if (!playVrma('idle')) stopVrma()
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
