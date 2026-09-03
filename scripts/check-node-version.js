const requiredMajor = 24
const currentMajor = Number(process.versions.node.split('.')[0])

if (!Number.isInteger(currentMajor) || currentMajor < requiredMajor) {
  console.error(`Node.js ${requiredMajor}+ is required; current runtime is ${process.version}.`)
  console.error('Run: nvm use 24')
  process.exit(1)
}
