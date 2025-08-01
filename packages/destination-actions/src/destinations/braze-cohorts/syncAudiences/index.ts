import { ActionDefinition, RequestClient, PayloadValidationError, Features } from '@segment/actions-core'
import type { Settings } from '../generated-types'
import type { Payload } from './generated-types'
import { SyncAudiences } from '../api'
import { CohortChanges, UserAlias } from '../braze-cohorts-types'
import { StateContext } from '@segment/actions-core/destination-kit'
import isEmpty from 'lodash/isEmpty'

const action: ActionDefinition<Settings, Payload> = {
  title: 'Sync Audience',
  description: 'Record custom events in Braze',
  defaultSubscription: 'event = "Audience Entered" or event = "Audience Exited"',
  fields: {
    external_id: {
      label: 'External User ID',
      description:
        'The external_id serves as a unique user identifier for whom you are submitting data. This identifier should be the same as the one you set in the Braze SDK in order to avoid creating multiple profiles for the same user.',
      type: 'string',
      default: {
        '@path': '$.userId'
      }
    },
    user_alias: {
      label: 'User Alias Object',
      description:
        'Alternate unique user identifier, this is required if External User ID or Device ID is not set. Refer [Braze Documentation](https://www.braze.com/docs/api/objects_filters/user_alias_object) for more details.',
      type: 'object',
      properties: {
        alias_name: {
          label: 'Alias Name',
          type: 'string',
          required: true
        },
        alias_label: {
          label: 'Alias Label',
          type: 'string',
          required: true
        }
      }
    },
    device_id: {
      label: 'Device ID',
      description:
        'Device IDs can be used to add and remove only anonymous users to/from a cohort. However, users with an assigned User ID cannot use Device ID to sync to a cohort.',
      type: 'string'
    },
    cohort_id: {
      label: 'Cohort ID',
      description: 'The Cohort Identifier',
      type: 'string',
      unsafe_hidden: true,
      required: true,
      default: {
        '@path': '$.context.personas.computation_id'
      }
    },
    cohort_name: {
      label: 'Cohort Name',
      description: 'The name of Cohort',
      type: 'string',
      unsafe_hidden: true,
      required: true,
      default: {
        '@path': '$.context.personas.computation_key'
      }
    },
    enable_batching: {
      label: 'Enable Batching',
      description: 'Enable batching of requests to the Braze cohorts.',
      type: 'boolean',
      default: true
    },
    personas_audience_key: {
      label: 'Segment Engage Audience Key',
      description:
        'The `audience_key` of the Engage audience you want to sync to Braze Cohorts. This value must be a hard-coded string variable, e.g. `personas_test_audience`, in order for batching to work properly.',
      type: 'string',
      required: true
    },
    event_properties: {
      label: 'Event Properties',
      description:
        'Displays properties of the event to add/remove users to a cohort and the traits of the specific user',
      type: 'object',
      required: true,
      unsafe_hidden: true,
      default: {
        '@if': {
          exists: { '@path': '$.properties' },
          then: { '@path': '$.properties' },
          else: { '@path': '$.traits' }
        }
      }
    },
    time: {
      label: 'Time',
      description: 'When the event occurred.',
      type: 'string',
      unsafe_hidden: true,
      required: true,
      default: {
        '@path': '$.timestamp'
      }
    },
    batch_keys: {
      label: 'Batch Keys',
      description: 'The keys to use for batching the events.',
      type: 'string',
      unsafe_hidden: true,
      default: ['cohort_name', 'cohort_id'],
      multiple: true,
      required: false
    }
  },
  perform: async (request, { settings, payload, stateContext, features }) => {
    return processPayload(request, settings, [payload], stateContext, features)
  },
  performBatch: async (request, { settings, payload, stateContext, features }) => {
    return processPayload(request, settings, payload, stateContext, features)
  }
}
async function processPayload(
  request: RequestClient,
  settings: Settings,
  payloads: Payload[],
  stateContext?: StateContext,
  features?: Features
) {
  validate(payloads)
  const syncAudiencesApiClient: SyncAudiences = new SyncAudiences(request, settings)
  const { cohort_name, cohort_id } = payloads[0]
  const cohortChanges: Array<CohortChanges> = []

  if (stateContext?.getRequestContext?.('cohort_name') != cohort_name) {
    await syncAudiencesApiClient.createCohort(settings, payloads[0])
    //setting cohort_name in cache context with ttl 0 so that it can keep the value as long as possible.
    stateContext?.setResponseContext?.(`cohort_name`, cohort_name, {})
  }
  let addUsers: CohortChanges, removeUsers: CohortChanges
  if (features?.['dedupe-braze-cohorts-v2']) {
    ;({ addUsers, removeUsers } = extractUsersV2(payloads))
  } else {
    ;({ addUsers, removeUsers } = extractUsers(payloads))
  }
  const hasAddUsers = hasUsersToAddOrRemove(addUsers)
  const hasRemoveUsers = hasUsersToAddOrRemove(removeUsers)

  // We should never hit this condition because at least an user_id or device_id
  // or user_alias is required in each payload, but if we do, returning early
  // rather than hitting Cohort's API (with no data) is more efficient.
  // The monoservice will interpret this early return as a 200.

  if (!hasAddUsers && !hasRemoveUsers) {
    return
  }
  if (hasAddUsers) {
    cohortChanges.push(addUsers)
  }
  if (hasRemoveUsers) {
    cohortChanges.push(removeUsers)
  }

  return await syncAudiencesApiClient.batchUpdate(settings, cohort_id, cohortChanges)
}

function validate(payloads: Payload[]): void {
  if (payloads[0].cohort_name !== payloads[0].personas_audience_key) {
    throw new PayloadValidationError('The value of `personas computation key` and `personas_audience_key` must match.')
  }
}

function extractUsersV2(payloads: Payload[]) {
  // sort by time in descending order
  // This is important because if a user is added and removed in the same batch,
  // we want to ensure that the last action is taken.
  payloads = payloads.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  const addUsers = { user_ids: new Set(), device_ids: new Set(), aliases: new Map() }
  const removeUsers = {
    user_ids: new Set(),
    device_ids: new Set(),
    aliases: new Map(),
    should_remove: true
  }

  payloads.forEach((payload: Payload) => {
    const { event_properties, external_id, device_id, user_alias, personas_audience_key } = payload
    const userEnteredOrRemoved: boolean = event_properties[`${personas_audience_key}`] as boolean
    const user = userEnteredOrRemoved ? addUsers : removeUsers

    // If the user is already in the cohort, we don't need to add them again.
    if (external_id && !addUsers.user_ids?.has(external_id) && !removeUsers.user_ids?.has(external_id)) {
      user?.user_ids?.add(external_id)
    } else if (device_id && !addUsers.device_ids?.has(device_id) && !removeUsers.device_ids?.has(device_id)) {
      user?.device_ids?.add(device_id)
    } else if (user_alias) {
      const aliasKey = `${user_alias.alias_name}:${user_alias.alias_label}`
      if (!addUsers.aliases?.has(aliasKey) && !removeUsers.aliases?.has(aliasKey)) {
        user?.aliases?.set(aliasKey, user_alias)
      }
    }
  })

  return {
    addUsers: {
      user_ids: toMayBeArray(addUsers.user_ids),
      device_ids: toMayBeArray(addUsers.device_ids),
      aliases: transformAliases(addUsers.aliases)
    } as CohortChanges,
    removeUsers: {
      user_ids: toMayBeArray(removeUsers.user_ids),
      device_ids: toMayBeArray(removeUsers.device_ids),
      aliases: transformAliases(removeUsers.aliases),
      should_remove: removeUsers.should_remove
    } as CohortChanges
  }
}

function extractUsers(payloads: Payload[]) {
  const addUsers: CohortChanges = { user_ids: [], device_ids: [], aliases: [] }
  const removeUsers: CohortChanges = { user_ids: [], device_ids: [], aliases: [], should_remove: true }

  payloads.forEach((payload: Payload) => {
    const { event_properties, external_id, device_id, user_alias, personas_audience_key } = payload
    const userEnteredOrRemoved: boolean = event_properties[`${personas_audience_key}`] as boolean
    const user = userEnteredOrRemoved ? addUsers : removeUsers

    if (external_id) {
      user?.user_ids?.push(external_id)
    } else if (device_id) {
      user?.device_ids?.push(device_id)
    } else if (user_alias) {
      user?.aliases?.push(user_alias)
    }
  })

  return {
    addUsers,
    removeUsers
  }
}

function transformAliases(aliases: Map<string, UserAlias> | undefined): UserAlias[] | undefined {
  if (!aliases) return undefined
  return Array.from(aliases.values()).map((alias) => ({
    alias_name: alias.alias_name,
    alias_label: alias.alias_label
  }))
}

function toMayBeArray<T>(set: Set<T> | undefined): T[] | undefined {
  return set ? Array.from(set) : undefined
}

function hasUsersToAddOrRemove(user: CohortChanges): boolean {
  return !(isEmpty(user?.user_ids) && isEmpty(user?.device_ids) && isEmpty(user?.aliases))
}

export default action
