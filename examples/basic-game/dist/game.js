const canvas = document.querySelector('#game')
const status = document.querySelector('#status')
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })

if (!gl) {
  status.textContent = 'WebGL2 unavailable'
  status.style.color = '#ff725e'
  throw new Error('WebGL2 is required')
}

function resize() {
  const scale = Math.min(devicePixelRatio, 2)
  canvas.width = Math.max(1, Math.floor(innerWidth * scale))
  canvas.height = Math.max(1, Math.floor(innerHeight * scale))
  gl.viewport(0, 0, canvas.width, canvas.height)
}

addEventListener('resize', resize)
resize()

let frame = 0
function render() {
  frame += 1
  const pulse = 0.03 * Math.sin(frame / 60)
  gl.clearColor(0.05 + pulse, 0.12, 0.18 - pulse, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.enable(gl.SCISSOR_TEST)
  const radius = Math.min(canvas.width, canvas.height) * 0.28
  const size = Math.max(36, Math.floor(Math.min(canvas.width, canvas.height) * 0.12))
  for (let index = 0; index < 5; index += 1) {
    const angle = frame * 0.018 + index * Math.PI * 0.4
    const x = canvas.width * 0.5 + Math.cos(angle) * radius - size * 0.5
    const y = canvas.height * 0.5 + Math.sin(angle * 1.3) * radius - size * 0.5
    gl.scissor(Math.floor(x), Math.floor(y), size, size)
    gl.clearColor(0.18 + index * 0.12, 0.72 - index * 0.08, 0.95, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  gl.disable(gl.SCISSOR_TEST)
  requestAnimationFrame(render)
}
render()
