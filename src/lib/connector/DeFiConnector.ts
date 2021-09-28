/* eslint-disable @typescript-eslint/camelcase */
import 'regenerator-runtime/runtime'
import { IWalletConnectOptions } from '@deficonnect/types'
import Web3Provider from '@deficonnect/web3-provider'
import { SessionStorage } from '../SessionStorage'
import { addUrlParams } from '../tools'
import { DeFiConnectorClient } from '../DeFiConnectorClient'
import { DeFiWeb3ConnectorArguments } from './DeFiWeb3Connector'
import { InstallExtensionQRCodeModal } from '../InstallExtensionModal'
import { DeFiCosmosProvider, isDeFiCosmosProvider } from './DeFiCosmosProvider'

export interface DeFiConnectorArguments {
  name: string
  supprtedChainTypes: DeFiConnectorChainType[]
  bridge?: string
  eth?: DeFiWeb3ConnectorArguments
  cosmos?: DeFiCosmosConnectorArguments
}

export interface DeFiCosmosConnectorArguments {
  supportedChainIds: string[]
}

export interface DeFiConnectorProviderGenerateArguments {
  chainId: string
  chainType: string
  config: DeFiConnectorArguments
  connectorClient: DeFiConnectorClient
}

export type DeFiConnectorEventCallback = (param?: DeFiConnectorUpdate, error?: Error) => void
export type DeFiConnectorEventUnsubscribe = () => void

export enum DeFiConnectorUpdateEvent {
  Update = 'DeFiConnectorUpdate',
  Error = 'DeFiConnectorError',
  Deactivate = 'DeFiConnectorDeactivate',
}

interface EventEmitter {
  event: DeFiConnectorUpdateEvent
  callback: DeFiConnectorEventCallback
}

export type DeFiConnectorChainType = 'eth' | 'cosmos'
export interface DeFiConnectorUpdate {
  chainType?: DeFiConnectorChainType
  chainId?: string
  account?: string
  provider?: DeFiConnectorProvider
}

export type DeFiAddressType = 'eth' | 'cro' | 'tcro'
export interface DeFiAddressTuple {
  type: DeFiAddressType
  address: string
}

export type DeFiConnectorProvider = DeFiCosmosProvider | Web3Provider

const GLOBAL_DEFILINK_BRIDGE_URL = 'https://wallet-connect.crypto.com/api/v1/ncwconnect/relay/ws'

const formaChainType = (value: any): DeFiConnectorChainType => {
  if (value === 'eth' || value === 'cosmos') {
    return value
  }
  return 'eth'
}

export class DeFiConnector {
  config: DeFiConnectorArguments
  eventEmitters: EventEmitter[] = []
  connectorClient?: DeFiConnectorClient

  private _provider?: DeFiConnectorProvider

  constructor(config: DeFiConnectorArguments) {
    this.config = config
  }

  async generateClient(): Promise<DeFiConnectorClient> {
    let connectorClient: DeFiConnectorClient
    if (typeof window.deficonnectClientGenerator === 'function') {
      connectorClient = await window.deficonnectClientGenerator(this.config)
    } else {
      const wcConfig: IWalletConnectOptions = {
        bridge: addUrlParams(this.config.bridge ?? GLOBAL_DEFILINK_BRIDGE_URL, {
          role: 'dapp',
          dapp_name: this.config.name,
        }),
        qrcodeModal: InstallExtensionQRCodeModal,
      }
      connectorClient = new DeFiConnectorClient(wcConfig, new SessionStorage())
    }
    connectorClient.connector.on('disconnect', () => {
      this.emitDeactivate()
    })
    connectorClient.connector.on('session_update', (error: Error | null, payload: any | null) => {
      if (error) {
        this.emitError(error)
        return
      }
      this.emitUpdate({
        account: this.account,
        chainType: this.chainType,
        chainId: this.chainId,
        provider: this.provider,
      })
    })
    return connectorClient
  }

  async generateProvider(params: DeFiConnectorProviderGenerateArguments): Promise<DeFiConnectorProvider> {
    const { chainId, chainType, connectorClient } = params
    if (typeof window.deficonnectProviderGenerator === 'function') {
      return await window.deficonnectProviderGenerator({ chainId, chainType, config: this.config, connectorClient })
    } else {
      if (chainType === 'eth') {
        return new Web3Provider({
          ...this.config.eth,
          connector: connectorClient.connector,
        })
      }
      if (chainType === 'cosmos') {
        return new DeFiCosmosProvider({
          supportedChainIds: this.config.cosmos?.supportedChainIds ?? [],
          client: connectorClient,
        })
      }
    }
    throw new Error('must provider eth or cosmos config')
  }

  async activate(): Promise<DeFiConnectorUpdate> {
    try {
      let connectorClient = this.connectorClient
      if (!connectorClient) {
        connectorClient = await this.generateClient()
      }
      if (this.config.supprtedChainTypes.length == 0) {
        throw new Error('must provider supprtedNetworks')
      }
      const chainType = this.config.supprtedChainTypes[0]
      let chainId = '1'
      if (chainType === 'eth') {
        if (this.config.eth == undefined) {
          throw new Error('must provider eth config')
        }
        chainId = `${this.config.eth.supportedChainIds[0] ?? 1}`
      }
      if (chainType === 'cosmos') {
        if (this.config.cosmos == undefined) {
          throw new Error('must provider eth config')
        }
        chainId = `${this.config.cosmos.supportedChainIds[0] ?? 1}`
      }
      this.provider = await this.generateProvider({ chainId, chainType, connectorClient, config: this.config })

      await connectorClient.connector.connect({ chainId, chainType })
      await this.provider?.enable()
      this.connectorClient = connectorClient
      return {
        account: this.account,
        chainType: this.chainType,
        chainId: this.chainId,
        provider: this.provider,
      }
    } catch (error) {
      console.error('DeFiConnector activate error:', error)
      throw error
    }
  }

  getAddressList(addressTypes: DeFiAddressType[]): DeFiAddressTuple[] {
    const connectorClient = this.connectorClient
    if (!connectorClient) {
      throw new Error('you has not active this connector')
    }
    return addressTypes.map((type) => {
      return {
        type,
        address: connectorClient.connector.session.wallets[0].address[type],
      }
    })
  }

  async deactivate(): Promise<void> {
    if (!this.connectorClient) {
      return
    }
  }

  get chainId(): string {
    return `${this.connectorClient?.connector.session.chainId ?? ''}`
  }

  get chainType(): DeFiConnectorChainType {
    return formaChainType(this.connectorClient?.connector.session.chainType)
  }

  get account(): string {
    switch (this.chainType) {
      case 'eth':
        return this.connectorClient?.connector.session.accounts[0] ?? ''
      case 'cosmos':
        if (isDeFiCosmosProvider(this.provider)) {
          return this.provider.account
        }
        return ''
    }
  }

  get provider(): DeFiConnectorProvider | undefined {
    return this._provider
  }
  set provider(value: DeFiConnectorProvider | undefined) {
    this._provider = value
  }

  on(event: DeFiConnectorUpdateEvent, callback: DeFiConnectorEventCallback): DeFiConnectorEventUnsubscribe {
    const eventEmitter = { event, callback }
    this.eventEmitters.push(eventEmitter)
    return () => {
      this.eventEmitters = this.eventEmitters.filter((item) => item !== eventEmitter)
    }
  }

  protected emitUpdate(update: DeFiConnectorUpdate): void {
    this.eventEmitters.forEach((emitter) => {
      if (emitter.event == DeFiConnectorUpdateEvent.Update) {
        emitter.callback(update, undefined)
      }
    })
  }

  protected emitError(error: Error): void {
    this.eventEmitters.forEach((emitter) => {
      if (emitter.event == DeFiConnectorUpdateEvent.Error) {
        emitter.callback(undefined, error)
      }
    })
  }

  protected emitDeactivate(): void {
    this.eventEmitters.forEach((emitter) => {
      if (emitter.event == DeFiConnectorUpdateEvent.Deactivate) {
        emitter.callback(undefined, undefined)
      }
    })
    this.connectorClient = undefined
  }
}
