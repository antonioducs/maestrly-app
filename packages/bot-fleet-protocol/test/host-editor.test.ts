import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_EDITOR_PREFIX,
  FLEET_INSTANCE_EDITOR_PREFIX,
  fleetGatewayEditorPath,
  isFleetHostEditorForwardedHost,
  parseFleetGatewayEditorPath,
  parseFleetInstanceEditorPath,
} from '../src/index.js'

describe('host editor routes', () => {
  it('put the environment after `/v1` of the instance prefix, as other environment routes do', () => {
    expect(FLEET_GATEWAY_EDITOR_PREFIX).toBe(FLEET_INSTANCE_EDITOR_PREFIX.replace(/^\/v1\//, '/v1/environments/:eid/'))
  })

  it('carry every editor path under the prefix, and nothing else', () => {
    expect(fleetGatewayEditorPath('workspaces')).toBe('/v1/environments/workspaces/editor/')
    expect(fleetGatewayEditorPath('workspaces', '/stable-abc/static/out/a.js')).toBe(
      '/v1/environments/workspaces/editor/stable-abc/static/out/a.js'
    )
    expect(parseFleetGatewayEditorPath('/v1/environments/workspaces/editor/stable-abc')).toEqual({
      environmentId: 'workspaces',
      editorPath: '/stable-abc',
    })
    expect(parseFleetGatewayEditorPath('/v1/environments/workspaces/editor')).toEqual({
      environmentId: 'workspaces',
      editorPath: '/',
    })
    for (const path of [
      '/v1/environments/workspaces/editors',
      '/v1/environments/workspaces/host-files/stat',
      '/v1/environments//editor/',
      '/v1/environments/a%2Fb/editor/',
      '/v1/environments/%E0%A4%A/editor/',
      '/v1/editor/',
    ])
      expect(parseFleetGatewayEditorPath(path)).toBeNull()

    expect(parseFleetInstanceEditorPath('/v1/editor')).toBe('/')
    expect(parseFleetInstanceEditorPath('/v1/editor/stable-abc?x=1')).toBe('/stable-abc?x=1')
    expect(parseFleetInstanceEditorPath('/v1/editorial')).toBeNull()
    expect(parseFleetInstanceEditorPath('/v1/bridge')).toBeNull()
  })

  it('accept only a loopback origin as the address the editor runs at', () => {
    expect(isFleetHostEditorForwardedHost('127.0.0.1:41234')).toBe(true)
    expect(isFleetHostEditorForwardedHost('localhost:8080')).toBe(true)
    for (const value of ['example.com:443', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:70000', '10.0.0.1:80', 7, undefined])
      expect(isFleetHostEditorForwardedHost(value)).toBe(false)
  })
})
