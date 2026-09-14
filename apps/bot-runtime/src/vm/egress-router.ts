import { ControlRouter } from './control-router.js'
/** Separate physical lane; it never accepts provisioning or administrative RPCs. */
export class EgressRouter extends ControlRouter {
  constructor() { super('egress') }
}
