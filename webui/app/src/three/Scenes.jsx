import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Float, Stars, Sparkles, MeshDistortMaterial, MeshWobbleMaterial } from '@react-three/drei'

/* ============================================================
   Shared building blocks
   ============================================================ */

// Eases the whole scene toward the mouse for a parallax feel.
// The canvas has pointer-events:none, so we listen on window.
function Rig({ children, factor = 0.22 }) {
  const ref = useRef()
  const ptr = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const h = (e) => {
      ptr.current.x = (e.clientX / window.innerWidth) * 2 - 1
      ptr.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', h, { passive: true })
    return () => window.removeEventListener('pointermove', h)
  }, [])
  useFrame((_, dt) => {
    if (!ref.current) return
    const k = Math.min(dt * 2.2, 1)
    ref.current.rotation.y += (ptr.current.x * factor - ref.current.rotation.y) * k
    ref.current.rotation.x += (-ptr.current.y * factor * 0.55 - ref.current.rotation.x) * k
  })
  return <group ref={ref}>{children}</group>
}

// Simple cartoon face: two eyes + smile arc. Attach to any character group.
function Face({ color = '#16161f', y = 0.15, z = 0.92, gap = 0.3, eye = 0.1, smile = 0.22 }) {
  return (
    <group position={[0, y, z]}>
      <mesh position={[-gap, 0, 0]}><sphereGeometry args={[eye, 12, 10]} /><meshBasicMaterial color={color} /></mesh>
      <mesh position={[gap, 0, 0]}><sphereGeometry args={[eye, 12, 10]} /><meshBasicMaterial color={color} /></mesh>
      <mesh position={[0, -0.22, 0]} rotation={[0, 0, Math.PI]}>
        <torusGeometry args={[smile, eye * 0.38, 8, 16, Math.PI]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

// Generic falling/drifting instanced particles (petals, leaves, embers…).
function Drifters({ count = 120, color = '#f9a8d4', area = [18, 14, 7], fall = 0.7, size = 0.09, flat = true, opacity = 0.85 }) {
  const ref = useRef()
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const seeds = useMemo(() => Array.from({ length: count }, () => ({
    x: (Math.random() - 0.5) * area[0],
    y: (Math.random() - 0.5) * area[1],
    z: (Math.random() - 0.5) * area[2] - 1,
    fall: (0.4 + Math.random()) * fall,
    sway: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 2.4,
    s: 0.55 + Math.random() * 0.9,
  })), [count, area, fall])
  useFrame((state) => {
    if (!ref.current) return
    const t = state.clock.elapsedTime
    const H = area[1]
    for (let i = 0; i < count; i++) {
      const s = seeds[i]
      const y = ((s.y - t * s.fall) % H + H * 1.5) % H - H / 2
      dummy.position.set(s.x + Math.sin(t * 0.7 + s.sway) * 0.9, y, s.z)
      dummy.rotation.set(t * s.spin, s.sway + t * 0.5, t * s.spin * 0.6)
      dummy.scale.set(s.s, s.s * (flat ? 1.5 : 1), s.s)
      dummy.updateMatrix()
      ref.current.setMatrixAt(i, dummy.matrix)
    }
    ref.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      {flat ? <circleGeometry args={[size, 7]} /> : <sphereGeometry args={[size, 6, 5]} />}
      <meshBasicMaterial color={color} side={THREE.DoubleSide} transparent opacity={opacity} depthWrite={false} />
    </instancedMesh>
  )
}

// Matrix-style streaming points.
function Rain({ count = 700, color = '#22c55e', area = [20, 15, 9], speed = 3, size = 0.07 }) {
  const ref = useRef()
  const data = useMemo(() => {
    const pos = new Float32Array(count * 3)
    const vel = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * area[0]
      pos[i * 3 + 1] = (Math.random() - 0.5) * area[1]
      pos[i * 3 + 2] = (Math.random() - 0.5) * area[2] - 2
      vel[i] = (0.35 + Math.random()) * speed
    }
    return { pos, vel }
  }, [count, area, speed])
  useFrame((_, dt) => {
    if (!ref.current) return
    const p = ref.current.geometry.attributes.position
    for (let i = 0; i < count; i++) {
      p.array[i * 3 + 1] -= data.vel[i] * dt
      if (p.array[i * 3 + 1] < -area[1] / 2) p.array[i * 3 + 1] = area[1] / 2
    }
    p.needsUpdate = true
  })
  return (
    <points ref={ref} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={data.pos} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color={color} size={size} transparent opacity={0.85} sizeAttenuation depthWrite={false} />
    </points>
  )
}

const wave = (t, speed = 1, amp = 1, phase = 0) => Math.sin(t * speed + phase) * amp

/* ============================================================
   MIDNIGHT — "Cosmo & Nova": alien + astronaut among the stars
   ============================================================ */

function Alien({ position = [0, 0, 0], scale = 1 }) {
  const arm = useRef()
  useFrame((s) => { if (arm.current) arm.current.rotation.z = -0.9 + wave(s.clock.elapsedTime, 3, 0.35) })
  return (
    <Float speed={1.6} rotationIntensity={0.25} floatIntensity={1.2}>
      <group position={position} scale={scale}>
        <mesh scale={[1, 1.12, 0.92]}><sphereGeometry args={[1, 32, 24]} /><meshStandardMaterial color="#6366f1" roughness={0.35} /></mesh>
        {/* one big eye */}
        <mesh position={[0, 0.28, 0.78]}><sphereGeometry args={[0.34, 24, 18]} /><meshStandardMaterial color="#fff" roughness={0.15} /></mesh>
        <mesh position={[0, 0.28, 1.04]}><sphereGeometry args={[0.15, 16, 12]} /><meshBasicMaterial color="#16161f" /></mesh>
        <mesh position={[0, -0.18, 0.88]} rotation={[0, 0, Math.PI]}>
          <torusGeometry args={[0.18, 0.04, 8, 16, Math.PI]} /><meshBasicMaterial color="#16161f" />
        </mesh>
        {/* antennae */}
        {[-0.35, 0.35].map((x, i) => (
          <group key={i} position={[x, 1.0, 0]} rotation={[0, 0, -x * 0.6]}>
            <mesh position={[0, 0.25, 0]}><cylinderGeometry args={[0.03, 0.03, 0.5, 8]} /><meshStandardMaterial color="#6366f1" /></mesh>
            <mesh position={[0, 0.55, 0]}><sphereGeometry args={[0.09, 12, 10]} /><meshStandardMaterial color="#a855f7" emissive="#a855f7" emissiveIntensity={1.4} /></mesh>
          </group>
        ))}
        {/* arms — right one waves */}
        <mesh position={[-0.95, -0.1, 0]} rotation={[0, 0, 0.7]}>
          <capsuleGeometry args={[0.14, 0.5, 6, 12]} /><meshStandardMaterial color="#6366f1" roughness={0.35} />
        </mesh>
        <group position={[0.95, 0.1, 0]} ref={arm}>
          <mesh position={[0, 0.3, 0]}><capsuleGeometry args={[0.14, 0.5, 6, 12]} /><meshStandardMaterial color="#6366f1" roughness={0.35} /></mesh>
        </group>
        {[-0.4, 0.4].map((x, i) => (
          <mesh key={i} position={[x, -1.1, 0]}><capsuleGeometry args={[0.16, 0.3, 6, 12]} /><meshStandardMaterial color="#5558d9" roughness={0.4} /></mesh>
        ))}
      </group>
    </Float>
  )
}

function Astronaut({ position = [0, 0, 0], scale = 1 }) {
  return (
    <Float speed={2.1} rotationIntensity={0.5} floatIntensity={1.6}>
      <group position={position} scale={scale} rotation={[0.1, -0.3, 0.15]}>
        <mesh><capsuleGeometry args={[0.55, 0.7, 8, 18]} /><meshStandardMaterial color="#f4f5fa" roughness={0.3} /></mesh>
        <mesh position={[0, 0.75, 0.05]}><sphereGeometry args={[0.48, 24, 18]} /><meshStandardMaterial color="#fff" roughness={0.2} /></mesh>
        {/* visor */}
        <mesh position={[0, 0.75, 0.3]} scale={[1, 0.82, 0.62]}><sphereGeometry args={[0.36, 24, 18]} /><meshStandardMaterial color="#10121e" roughness={0.05} metalness={0.6} /></mesh>
        <mesh position={[0, -0.1, -0.45]}><boxGeometry args={[0.65, 0.8, 0.3]} /><meshStandardMaterial color="#c7cbe0" roughness={0.5} /></mesh>
        {[[-0.62, 0.25, 0.55], [0.62, 0.1, -0.4]].map(([x, y, rz], i) => (
          <mesh key={i} position={[x, y, 0]} rotation={[0, 0, rz]}><capsuleGeometry args={[0.13, 0.45, 6, 12]} /><meshStandardMaterial color="#e7e9f4" roughness={0.35} /></mesh>
        ))}
        {[-0.25, 0.25].map((x, i) => (
          <mesh key={i} position={[x, -0.85, 0.05]} rotation={[0.3, 0, 0]}><capsuleGeometry args={[0.15, 0.45, 6, 12]} /><meshStandardMaterial color="#e7e9f4" roughness={0.35} /></mesh>
        ))}
      </group>
    </Float>
  )
}

function MidnightScene() {
  return (
    <>
      <color attach="background" args={['#0a0c14']} />
      <fog attach="fog" args={['#0a0c14', 10, 26]} />
      <ambientLight intensity={0.85} />
      <pointLight position={[6, 5, 6]} intensity={90} color="#8b8cf8" />
      <pointLight position={[-7, -3, 4]} intensity={35} color="#a855f7" />
      <Stars radius={55} depth={35} count={2200} factor={3.2} fade speed={0.8} />
      <Sparkles count={70} scale={[16, 10, 8]} size={2.6} speed={0.35} color="#a78bfa" opacity={0.65} />
      <Rig>
        <Alien position={[3.4, 0.2, -1]} scale={1.05} />
        <Astronaut position={[-3.8, -0.6, -2]} scale={0.95} />
        {/* distant ringed planet */}
        <group position={[-1, 3.4, -9]} rotation={[0.5, 0, -0.35]}>
          <mesh><sphereGeometry args={[1.1, 24, 18]} /><meshStandardMaterial color="#4338ca" roughness={0.7} /></mesh>
          <mesh rotation={[Math.PI / 2.2, 0, 0]}><torusGeometry args={[1.7, 0.09, 8, 48]} /><meshStandardMaterial color="#a855f7" emissive="#a855f7" emissiveIntensity={0.5} transparent opacity={0.8} /></mesh>
        </group>
      </Rig>
    </>
  )
}

/* ============================================================
   BLUEBERRY — "Sprinkles": glazed donut with drifting leaves
   ============================================================ */

function Donut({ position = [0, 0, 0], scale = 1 }) {
  const ref = useRef()
  useFrame((s) => {
    if (!ref.current) return
    ref.current.rotation.z = wave(s.clock.elapsedTime, 0.4, 0.25)
    ref.current.rotation.y = wave(s.clock.elapsedTime, 0.3, 0.3, 1)
  })
  const sprinkles = useMemo(() => Array.from({ length: 46 }, () => {
    const th = Math.random() * Math.PI * 2
    const r = 0.62 + Math.random() * 0.74
    const z = Math.sqrt(Math.max(0.47 ** 2 - (r - 1) ** 2, 0.02))
    return { x: Math.cos(th) * r, y: Math.sin(th) * r, z: z * 0.95 + 0.06, rot: Math.random() * Math.PI, tilt: (Math.random() - 0.5) * 0.9, c: ['#f0abfc', '#fef08a', '#86efac', '#fff'][Math.floor(Math.random() * 4)] }
  }), [])
  return (
    <Float speed={1.4} rotationIntensity={0.15} floatIntensity={1.1}>
      <group position={position} scale={scale} ref={ref}>
        {/* dough */}
        <mesh><torusGeometry args={[1, 0.45, 24, 56]} /><meshStandardMaterial color="#e3a35c" roughness={0.55} /></mesh>
        {/* icing: slightly fatter torus squashed onto the front */}
        <mesh position={[0, 0, 0.16]} scale={[1.02, 1.02, 0.62]}>
          <torusGeometry args={[1, 0.48, 24, 56]} />
          <meshStandardMaterial color="#a855f7" roughness={0.3} />
        </mesh>
        {sprinkles.map((s, i) => (
          <mesh key={i} position={[s.x, s.y, s.z]} rotation={[s.tilt, 0, s.rot]}>
            <capsuleGeometry args={[0.025, 0.09, 4, 8]} /><meshStandardMaterial color={s.c} roughness={0.3} />
          </mesh>
        ))}
        {/* face on the lower ring */}
        <group position={[0, -0.97, 0.55]}>
          <mesh position={[-0.2, 0.05, 0]}><sphereGeometry args={[0.07, 12, 10]} /><meshBasicMaterial color="#2b1551" /></mesh>
          <mesh position={[0.2, 0.05, 0]}><sphereGeometry args={[0.07, 12, 10]} /><meshBasicMaterial color="#2b1551" /></mesh>
          <mesh position={[0, -0.12, 0]} rotation={[0, 0, Math.PI]}><torusGeometry args={[0.13, 0.026, 8, 16, Math.PI]} /><meshBasicMaterial color="#2b1551" /></mesh>
        </group>
      </group>
    </Float>
  )
}

function BlueberryScene() {
  return (
    <>
      <color attach="background" args={['#38206b']} />
      <fog attach="fog" args={['#38206b', 11, 26]} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[4, 6, 5]} intensity={1.6} color="#ffe8ff" />
      <pointLight position={[-6, -2, 3]} intensity={40} color="#f0abfc" />
      <Sparkles count={60} scale={[16, 10, 7]} size={3} speed={0.3} color="#f0abfc" opacity={0.6} />
      <Rig>
        <Donut position={[3.3, 0.3, -1.2]} scale={1.25} />
        {/* mini donut buddy */}
        <Float speed={2} rotationIntensity={0.6} floatIntensity={1.8}>
          <group position={[-4.2, 1.6, -3.5]} rotation={[0.4, 0, 0.3]} scale={0.5}>
            <mesh><torusGeometry args={[1, 0.45, 18, 40]} /><meshStandardMaterial color="#e3a35c" roughness={0.55} /></mesh>
            <mesh position={[0, 0, 0.16]} scale={[1.02, 1.02, 0.62]}><torusGeometry args={[1, 0.48, 18, 40]} /><meshStandardMaterial color="#f0abfc" roughness={0.3} /></mesh>
          </group>
        </Float>
        {/* drifting leaves like the bakery hero shot */}
        <Drifters count={26} color="#6ee7a0" size={0.22} fall={0.35} opacity={0.9} />
        <Drifters count={40} color="#d8b4fe" size={0.07} fall={0.5} opacity={0.7} />
      </Rig>
    </>
  )
}

/* ============================================================
   DAYLIGHT — "Sunny": warm sun + drifting puffy clouds
   ============================================================ */

function Puffs({ position = [0, 0, 0], scale = 1, speed = 0.25 }) {
  const ref = useRef()
  useFrame((s) => {
    if (!ref.current) return
    ref.current.position.x = ((position[0] + s.clock.elapsedTime * speed + 14) % 28) - 14
  })
  const blobs = [[0, 0, 0, 1], [0.95, 0.12, 0.25, 0.72], [-0.95, 0.08, -0.15, 0.78], [0.3, 0.5, 0, 0.62], [-0.45, 0.45, 0.2, 0.55]]
  return (
    <group ref={ref} position={position} scale={scale}>
      {blobs.map(([x, y, z, s], i) => (
        <mesh key={i} position={[x, y, z]}><sphereGeometry args={[s, 18, 14]} /><meshStandardMaterial color="#ffffff" roughness={1} /></mesh>
      ))}
    </group>
  )
}

function Sun({ position = [0, 0, 0], scale = 1 }) {
  const rays = useRef()
  useFrame((s) => { if (rays.current) rays.current.rotation.z = s.clock.elapsedTime * 0.25 })
  return (
    <Float speed={1.5} rotationIntensity={0.1} floatIntensity={0.9}>
      <group position={position} scale={scale}>
        <mesh><sphereGeometry args={[0.85, 28, 22]} /><meshStandardMaterial color="#fcd34d" emissive="#f59e0b" emissiveIntensity={0.55} roughness={0.4} /></mesh>
        <group ref={rays}>
          {Array.from({ length: 9 }, (_, i) => {
            const a = (i / 9) * Math.PI * 2
            return (
              <mesh key={i} position={[Math.cos(a) * 1.25, Math.sin(a) * 1.25, 0]} rotation={[0, 0, a - Math.PI / 2]}>
                <coneGeometry args={[0.1, 0.34, 6]} /><meshStandardMaterial color="#fbbf24" emissive="#f59e0b" emissiveIntensity={0.5} />
              </mesh>
            )
          })}
        </group>
        <Face color="#7c4a03" y={0.1} z={0.78} gap={0.27} eye={0.08} smile={0.2} />
      </group>
    </Float>
  )
}

function DaylightScene() {
  return (
    <>
      <color attach="background" args={['#cfe6fb']} />
      <fog attach="fog" args={['#cfe6fb', 12, 30]} />
      <ambientLight intensity={1.15} />
      <directionalLight position={[5, 8, 6]} intensity={2} color="#fff7e0" />
      <Sparkles count={40} scale={[16, 10, 6]} size={2.2} speed={0.2} color="#ffffff" opacity={0.7} />
      <Rig factor={0.16}>
        <Sun position={[3.7, 1.8, -2]} scale={1.05} />
        <Puffs position={[-4, 0.4, -3]} scale={1.15} speed={0.22} />
        <Puffs position={[2, -1.9, -4.5]} scale={0.9} speed={0.3} />
        <Puffs position={[-9, 2.6, -6]} scale={1.4} speed={0.16} />
        <Puffs position={[7, 3, -7]} scale={0.8} speed={0.26} />
      </Rig>
    </>
  )
}

/* ============================================================
   SYNTHWAVE — "Kuba": neon holo-cube over an endless grid
   ============================================================ */

function HoloCube({ position = [0, 0, 0], scale = 1 }) {
  const inner = useRef()
  const outer = useRef()
  useFrame((s) => {
    const t = s.clock.elapsedTime
    if (inner.current) { inner.current.rotation.y = t * 0.5; inner.current.rotation.x = Math.sin(t * 0.35) * 0.35 }
    if (outer.current) { outer.current.rotation.y = -t * 0.32; outer.current.rotation.x = Math.cos(t * 0.3) * 0.3 }
  })
  return (
    <Float speed={1.6} rotationIntensity={0.2} floatIntensity={1.2}>
      <group position={position} scale={scale}>
        <group ref={inner}>
          <mesh>
            <boxGeometry args={[1.7, 1.7, 1.7]} />
            <meshStandardMaterial color="#2a1850" metalness={0.7} roughness={0.25} emissive="#f472b6" emissiveIntensity={0.16} />
          </mesh>
          {/* cute face on one cube face */}
          <group position={[0, 0.1, 0.88]}>
            <mesh position={[-0.32, 0, 0]}><sphereGeometry args={[0.1, 12, 10]} /><meshBasicMaterial color="#67e8f9" /></mesh>
            <mesh position={[0.32, 0, 0]}><sphereGeometry args={[0.1, 12, 10]} /><meshBasicMaterial color="#67e8f9" /></mesh>
            <mesh position={[0, -0.32, 0]} rotation={[0, 0, Math.PI]}><torusGeometry args={[0.2, 0.035, 8, 16, Math.PI]} /><meshBasicMaterial color="#67e8f9" /></mesh>
          </group>
        </group>
        <mesh ref={outer} scale={1.35}>
          <boxGeometry args={[1.7, 1.7, 1.7]} />
          <meshBasicMaterial color="#22d3ee" wireframe transparent opacity={0.4} />
        </mesh>
      </group>
    </Float>
  )
}

function SynthwaveScene() {
  return (
    <>
      <color attach="background" args={['#150d24']} />
      <fog attach="fog" args={['#150d24', 8, 24]} />
      <ambientLight intensity={0.45} />
      <pointLight position={[6, 4, 5]} intensity={70} color="#f472b6" />
      <pointLight position={[-6, 2, 4]} intensity={55} color="#22d3ee" />
      <Stars radius={50} depth={30} count={1400} factor={2.6} fade speed={1.2} />
      <Rig>
        <HoloCube position={[3.4, 0.4, -1.5]} scale={1.05} />
        {/* floating neon shards */}
        {[[-4.5, 1.8, -3, '#f472b6'], [-2.8, -1.6, -2, '#22d3ee'], [5.5, -1.8, -4, '#a78bfa'], [-6.5, -0.2, -5, '#f472b6']].map(([x, y, z, c], i) => (
          <Float key={i} speed={2 + i * 0.3} rotationIntensity={1.4} floatIntensity={1.6}>
            <mesh position={[x, y, z]} scale={0.34 + (i % 3) * 0.12}>
              <octahedronGeometry args={[1, 0]} />
              <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.85} metalness={0.6} roughness={0.25} />
            </mesh>
          </Float>
        ))}
      </Rig>
      <gridHelper args={[70, 70, '#22d3ee', '#3b2364']} position={[0, -3.2, -5]} />
      <gridHelper args={[70, 70, '#f472b6', '#2a1850']} position={[0, 7.5, -5]} />
    </>
  )
}

/* ============================================================
   MATRIX — "Bit": glowing core inside the digital rain
   ============================================================ */

function BitCreature({ position = [0, 0, 0], scale = 1 }) {
  const core = useRef()
  const shell = useRef()
  useFrame((s) => {
    const t = s.clock.elapsedTime
    if (core.current) core.current.rotation.y = t * 0.6
    if (shell.current) { shell.current.rotation.y = -t * 0.4; shell.current.rotation.z = Math.sin(t * 0.5) * 0.3 }
  })
  return (
    <Float speed={1.8} rotationIntensity={0.2} floatIntensity={1.3}>
      <group position={position} scale={scale}>
        <group ref={core}>
          <mesh><octahedronGeometry args={[0.9, 0]} /><meshStandardMaterial color="#052e12" emissive="#22c55e" emissiveIntensity={0.9} roughness={0.25} metalness={0.5} /></mesh>
        </group>
        <mesh ref={shell} scale={1.5}><octahedronGeometry args={[0.9, 1]} /><meshBasicMaterial color="#4ade80" wireframe transparent opacity={0.35} /></mesh>
        <Face color="#bbf7d0" y={0.1} z={0.75} gap={0.24} eye={0.08} smile={0.16} />
      </group>
    </Float>
  )
}

function MatrixScene() {
  return (
    <>
      <color attach="background" args={['#04110a']} />
      <fog attach="fog" args={['#04110a', 7, 22]} />
      <ambientLight intensity={0.5} />
      <pointLight position={[4, 4, 6]} intensity={45} color="#22c55e" />
      <Rain count={750} color="#22c55e" speed={3.2} size={0.065} />
      <Rain count={250} color="#86efac" speed={5} size={0.1} />
      <Rig>
        <BitCreature position={[3.3, 0.2, -1.5]} scale={1.1} />
        <Sparkles count={50} scale={[14, 10, 6]} size={2.4} speed={0.5} color="#4ade80" opacity={0.5} />
      </Rig>
    </>
  )
}

/* ============================================================
   SAKURA — "Hana": blossom spirit in a petal storm
   ============================================================ */

function Hana({ position = [0, 0, 0], scale = 1 }) {
  return (
    <Float speed={1.7} rotationIntensity={0.25} floatIntensity={1.3}>
      <group position={position} scale={scale}>
        <mesh scale={[1, 1.05, 0.95]}>
          <sphereGeometry args={[0.95, 32, 24]} />
          <MeshWobbleMaterial color="#fdd5e5" factor={0.15} speed={1.4} roughness={0.35} />
        </mesh>
        <Face color="#7c2d4e" y={0.12} z={0.88} gap={0.3} eye={0.09} smile={0.2} />
        {/* blush */}
        <mesh position={[-0.52, -0.05, 0.78]} scale={[1, 0.6, 0.4]}><sphereGeometry args={[0.13, 12, 10]} /><meshBasicMaterial color="#fb7185" transparent opacity={0.55} /></mesh>
        <mesh position={[0.52, -0.05, 0.78]} scale={[1, 0.6, 0.4]}><sphereGeometry args={[0.13, 12, 10]} /><meshBasicMaterial color="#fb7185" transparent opacity={0.55} /></mesh>
        {/* flower crown */}
        <group position={[0.42, 0.92, 0.25]} rotation={[0.4, 0, -0.3]} scale={0.55}>
          {Array.from({ length: 5 }, (_, i) => {
            const a = (i / 5) * Math.PI * 2
            return <mesh key={i} position={[Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0]} scale={[1, 1, 0.45]}><sphereGeometry args={[0.16, 10, 8]} /><meshStandardMaterial color="#ec4899" roughness={0.4} /></mesh>
          })}
          <mesh position={[0, 0, 0.08]}><sphereGeometry args={[0.12, 10, 8]} /><meshStandardMaterial color="#fde047" roughness={0.4} /></mesh>
        </group>
      </group>
    </Float>
  )
}

function SakuraScene() {
  return (
    <>
      <color attach="background" args={['#fbe3ef']} />
      <fog attach="fog" args={['#fbe3ef', 11, 26]} />
      <ambientLight intensity={1.05} />
      <directionalLight position={[4, 6, 5]} intensity={1.5} color="#fff0f6" />
      <pointLight position={[-5, -2, 4]} intensity={25} color="#ec4899" />
      <Rig factor={0.18}>
        <Hana position={[3.6, 0.1, -1.4]} scale={1.05} />
        <Drifters count={150} color="#f9a8d4" size={0.085} fall={0.75} />
        <Drifters count={60} color="#fbcfe8" size={0.12} fall={0.5} opacity={0.7} />
        <Sparkles count={40} scale={[14, 10, 6]} size={2} speed={0.25} color="#f472b6" opacity={0.5} />
      </Rig>
    </>
  )
}

/* ============================================================
   ABYSS — "Mochi": jellyfish drifting through the deep
   ============================================================ */

function Jelly({ position = [0, 0, 0], scale = 1, color = '#22d3ee', face = true, phase = 0 }) {
  const grp = useRef()
  const dome = useRef()
  const tents = useRef([])
  useFrame((s) => {
    const t = s.clock.elapsedTime + phase
    if (grp.current) grp.current.position.y = position[1] + Math.sin(t * 0.7) * 0.45
    if (dome.current) { const p = 1 + Math.sin(t * 2.1) * 0.06; dome.current.scale.set(2 - p, p, 2 - p) }
    tents.current.forEach((m, i) => { if (m) m.rotation.x = Math.sin(t * 1.6 + i) * 0.22; if (m) m.rotation.z = Math.cos(t * 1.3 + i * 1.7) * 0.22 })
  })
  return (
    <group ref={grp} position={position} scale={scale}>
      <mesh ref={dome}>
        <sphereGeometry args={[1, 28, 18, 0, Math.PI * 2, 0, Math.PI / 1.75]} />
        <MeshDistortMaterial color={color} transparent opacity={0.72} distort={0.22} speed={2} emissive={color} emissiveIntensity={0.35} roughness={0.2} side={THREE.DoubleSide} />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2
        return (
          <group key={i} position={[Math.cos(a) * 0.55, -0.15, Math.sin(a) * 0.55]} ref={(el) => (tents.current[i] = el)}>
            <mesh position={[0, -0.75, 0]}>
              <capsuleGeometry args={[0.045, 1.35, 4, 8]} />
              <meshStandardMaterial color={color} transparent opacity={0.55} emissive={color} emissiveIntensity={0.3} />
            </mesh>
          </group>
        )
      })}
      {face && <Face color="#083344" y={0.32} z={0.86} gap={0.28} eye={0.09} smile={0.18} />}
    </group>
  )
}

function AbyssScene() {
  return (
    <>
      <color attach="background" args={['#07182b']} />
      <fog attach="fog" args={['#07182b', 7, 22]} />
      <ambientLight intensity={0.6} />
      <pointLight position={[5, 6, 5]} intensity={55} color="#38bdf8" />
      <pointLight position={[-6, -3, 3]} intensity={30} color="#06b6d4" />
      {/* god rays */}
      {[[-2.5, 0.18], [1.5, 0.12], [5, 0.15]].map(([x, o], i) => (
        <mesh key={i} position={[x, 6.5, -6]} rotation={[0, 0, 0.25 - i * 0.18]}>
          <coneGeometry args={[1.6, 14, 4, 1, true]} />
          <meshBasicMaterial color="#7dd3fc" transparent opacity={o} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      ))}
      <Rig>
        <Jelly position={[3.5, 0.4, -1.5]} scale={1.15} color="#22d3ee" />
        <Jelly position={[-4.5, -1, -4]} scale={0.6} color="#818cf8" face={false} phase={2} />
        <Jelly position={[-2, 2.4, -6]} scale={0.45} color="#38bdf8" face={false} phase={4} />
        {/* bubbles rise: reuse Rain flipped by negative speed via custom — Sparkles works fine */}
        <Sparkles count={110} scale={[16, 11, 7]} size={4} speed={0.45} color="#7dd3fc" opacity={0.55} />
        <Sparkles count={35} scale={[14, 10, 6]} size={7} speed={0.3} color="#bae6fd" opacity={0.3} />
      </Rig>
    </>
  )
}

/* ============================================================ */

const SCENES = {
  midnight: MidnightScene,
  blueberry: BlueberryScene,
  daylight: DaylightScene,
  synthwave: SynthwaveScene,
  matrix: MatrixScene,
  sakura: SakuraScene,
  abyss: AbyssScene,
}

export default SCENES
