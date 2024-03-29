import type { INodeType, INodeTypeDescription, ITriggerResponse } from 'n8n-workflow'
import type { ITriggerFunctions } from 'n8n-core'
import WebSocket from 'ws'
import { Script as VMScript, createContext as vmCreateContext } from 'vm'

const defaultOpenEventCode = `// Add your code here
$send({
  action: 'register',
  accessCode: $accessCode
})`

function parseMessage (data: any): Record<string, any> {
  const payload = Array.isArray(data)
    ? data.map(it => it.toString()).join('')
    : data.toString()

  let message

  try {
    message = JSON.parse(payload)
  } catch {
    message = { ...payload.split('') }
  }

  return message
}

export class WebSocketTrigger implements INodeType {
  description: INodeTypeDescription = {
    subtitle: '={{$parameter["url"]}}',
    displayName: 'WebSocket Trigger',
    name: 'webSocketTrigger',
    icon: 'file:websocket-trigger.svg',
    group: ['trigger'],
    version: 1,
    description: 'Starts the workflow when a websocket is opened',
    defaults: {
      name: 'WebSocket Trigger'
    },
    inputs: [],
    outputs: ['main'],
    parameterPane: 'wide',
    credentials: [
      {
        name: 'oAuth2Api',
        required: false
      }
    ],
    properties: [
      {
        displayName: 'URI',
        name: 'uri',
        type: 'string',
        default: '',
        placeholder: 'wss://example.com',
        description: 'The URI to open socket to',
        required: true
      },
      {
        displayName: 'Open Event Code',
        name: 'openEventCode',
        typeOptions: {
          editor: 'code'
        },
        type: 'string',
        default: defaultOpenEventCode,
        description: 'Code to execute when connected to socket',
        noDataExpression: true
      }
    ]
  }

  async trigger (this: ITriggerFunctions): Promise<ITriggerResponse> {
    const workflowMode = this.getMode()
    const uri = this.getNodeParameter('uri', 0) as string

    const auth = {
      accessToken: '',
      clientId: '',
      clientSecret: ''
    }

    try {
      const oAuth2Api = await this.getCredentials('oAuth2Api')
      const oAuthTokenData = oAuth2Api?.oauthTokenData as any

      auth.accessToken = oAuthTokenData?.access_token ?? ''
      auth.clientId = (oAuth2Api?.clientId as string) ?? ''
      auth.clientSecret = (oAuth2Api?.clientSecret as string) ?? ''
    } catch {
    }

    const client = {
      current: new WebSocket(uri)
    }

    let clientManuallyClosed = false

    async function handleOpen (this: ITriggerFunctions): Promise<void> {
      const openEventCode = this.getNodeParameter('openEventCode', 0) as string

      return await new Promise((resolve, reject) => {
        const ctx = {
          $auth: auth,
          $getNodeParameter: this.getNodeParameter,
          $getWorkflowStaticData: this.getWorkflowStaticData,
          helpers: this.helpers,
          thenCallback: resolve,
          catchCallback: reject,

          $send: async (data: any, waitResponse = false): Promise<any> => {
            if (typeof data === 'string') {
              client.current.send(data)
            } else {
              client.current.send(JSON.stringify(data))
            }

            if (waitResponse) {
              return await new Promise((resolve) => {
                client.current.once('message', (data) => {
                  resolve(parseMessage(data))
                })
              })
            }
          }
        }

        const script = new VMScript(
          `async function main () {${openEventCode}\n} main().then(thenCallback).catch(catchCallback)`
        )

        vmCreateContext(ctx)
        script.runInContext(ctx)
      })
    }

    async function handleConnect (this: ITriggerFunctions): Promise<void> {
      client.current = new WebSocket(uri)

      await new Promise((resolve, reject) => {
        console.log('connecting websocket')

        client.current.on('open', () => {
          console.log('opened websocket')

          handleOpen.call(this)
            .then(() => {
              client.current.on('message', (data) => {
                const message = parseMessage(data)
                console.log('received websocket message')
                console.log(message)
                this.emit([this.helpers.returnJsonArray(message)])
              })

              resolve(true)
            })
            .catch((err) => {
              console.log('errored websocket 1')
              console.error(err)
              reject(err)
            })
        })

        client.current.on('close', () => {
          console.log('closed websocket')

          if (!clientManuallyClosed) {
            const err = new Error('WebSocket connection closed unexpectedly')
            console.error(err)

            setTimeout(() => {
              handleConnect.bind(this)()
                .catch((err) => {
                  console.log('errored websocket 2')
                  console.error(err)
                })
            }, 5000)
          }
        })

        client.current.on('error', (err) => {
          console.log('errored websocket 3')
          console.error(err)
        })
      })
    }

    async function manualTriggerFunction (this: ITriggerFunctions): Promise<void> {
      await handleConnect.bind(this)()
    }

    async function closeFunction (this: ITriggerFunctions): Promise<void> {
      console.log('manual close websocket')
      clientManuallyClosed = true
      client.current.terminate()
    }

    if (workflowMode === 'trigger') {
      console.log('manually enabling workflow')
      await manualTriggerFunction.call(this)
    }

    return {
      closeFunction: closeFunction.bind(this),
      manualTriggerFunction: manualTriggerFunction.bind(this)
    }
  }
}
