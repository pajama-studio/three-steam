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
  requestAnimationFrame(render)
}
render()
