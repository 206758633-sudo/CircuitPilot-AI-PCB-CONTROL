import assert from 'node:assert/strict';
import test from 'node:test';
import { providerStatuses, startProviderLogin, testProvider } from '../providers.mjs';

test('provider status exposes summaries while Keychain remains abstracted', async () => {
  const requested = [];
  const keychain = { async configured(id) { requested.push(id); return id === 'openai_api'; } };
  const providers = await providerStatuses(keychain);
  assert.deepEqual(requested.sort(), ['anthropic_api', 'openai_api']);
  assert.deepEqual(providers.map((item) => item.id), ['codex_account', 'openai_api', 'claude_account', 'anthropic_api']);
  assert.equal(providers.find((item) => item.id === 'openai_api').ready, true);
  assert.equal(JSON.stringify(providers).includes('api-key'), false);
});

test('unknown provider cannot trigger a network request', async () => {
  await assert.rejects(() => testProvider('unknown', { read: async () => 'never' }), { code: 'PROVIDER_UNKNOWN' });
});

test('login short-circuits an already authenticated Codex account', async()=>{
  let spawned=false; const result=await startProviderLogin('codex_account',{findExecutable:async()=>'/fixed/codex',cliStatus:async()=>({authenticated:true,status:'Logged in using ChatGPT'}),startObserved:async()=>{spawned=true;}});
  assert.equal(result.state,'already_authenticated'); assert.equal(result.authenticated,true); assert.equal(spawned,false);
});

test('login reports early CLI exit instead of false success',async()=>{
  await assert.rejects(()=>startProviderLogin('codex_account',{findExecutable:async()=>'/fixed/codex',cliStatus:async()=>({authenticated:false}),startObserved:async()=>({state:'failed',started:false,detail:'browser launch failed'})}),{code:'LOGIN_PROCESS_EXITED'});
});
