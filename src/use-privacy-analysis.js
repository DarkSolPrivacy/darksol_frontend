import { useEffect, useSyncExternalStore } from 'react'
import { createAnalysisResource, preparedSimulation } from './privacy-analysis.js'

const resource = createAnalysisResource()
const empty = { loading: false, data: null }

// Both the ordinary and longer-wait suggestions share the same public table.
export function useSimulation(key, assetHint = null) {
  const request = key ? JSON.parse(key) : null
  const asset = request?.asset ?? assetHint
  const state = useSyncExternalStore((listener) => asset ? resource.subscribe(asset, listener) : () => {},
    () => asset ? resource.get(asset) : empty)
  useEffect(() => {
    if (!asset) return undefined
    resource.load(asset)
    const timer = setInterval(() => resource.load(asset), 60_000)
    return () => clearInterval(timer)
  }, [asset])
  return !key || state.loading ? null : { key, data: preparedSimulation(state.data, request) }
}
