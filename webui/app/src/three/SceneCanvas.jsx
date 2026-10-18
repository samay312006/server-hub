import React, { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import SCENES from './Scenes.jsx'

// Full-viewport WebGL backdrop. Sits at z-index 0 behind #app (z-index 1);
// pointer-events stay off so the UI is fully interactive above it.
export default function SceneCanvas({ theme }) {
  const Scene = SCENES[theme] || SCENES.midnight
  return (
    <div className="scene3d" aria-hidden="true">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0, 9], fov: 42 }}
        gl={{ alpha: false, antialias: true, powerPreference: 'high-performance' }}
        style={{ pointerEvents: 'none' }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>
    </div>
  )
}
