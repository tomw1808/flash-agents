import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raceWithBudget, createActivity, describeActivity } from '../lib/service.js'

const never = () => new Promise(() => {})

test('a call with no activity for the idle window stops with IDLE', async () => {
  const activity = createActivity(Date.now() - 1_000)
  await assert.rejects(
    raceWithBudget(never(), { timeoutMs: 60_000, idleTimeoutMs: 50, activity, label: 'flash_task', sessionId: 's1' }),
    (error) => error.code === 'IDLE' && /no activity/.test(error.message),
  )
})

test('activity keeps a call alive past the idle window', async () => {
  const activity = createActivity()
  const keepAlive = setInterval(() => { activity.at = Date.now() }, 10)
  const done = new Promise((resolve) => setTimeout(resolve, 200))
  await raceWithBudget(done, { timeoutMs: 60_000, idleTimeoutMs: 80, activity, label: 'flash_task', sessionId: 's1' })
  clearInterval(keepAlive)
})

test('the wall-clock budget still applies to a busy call', async () => {
  const activity = createActivity()
  const keepAlive = setInterval(() => { activity.at = Date.now() }, 5)
  await assert.rejects(
    raceWithBudget(never(), { timeoutMs: 60, idleTimeoutMs: 10_000, activity, label: 'flash_task', sessionId: 's1' }),
    (error) => error.code === 'TIMEOUT',
  )
  clearInterval(keepAlive)
})

test('the activity line names the step, what it was doing and how long ago', () => {
  const activity = createActivity(Date.now() - 65_000)
  activity.step = 112
  activity.what = 'tool bash'
  assert.match(describeActivity(activity), /^step 112 · tool bash · last event 1m\d+s ago$/)
})
