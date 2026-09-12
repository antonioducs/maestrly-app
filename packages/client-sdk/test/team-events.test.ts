import {it,expect} from 'vitest'
import {MaestrlyClient} from '../src/index.js'
it('stops a revoked project stream without parsing the control event as project data',async()=>{
 const client=new MaestrlyClient({baseUrl:'https://fixture.test',fetch:async()=>new Response('event: access_revoked\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})})
 const stream=client.events({organizationId:'org',projectId:'project'})
 await expect(stream.next()).rejects.toThrow('Project access was revoked.')
})
