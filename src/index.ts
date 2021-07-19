import {
  overrideProcessConsole,
  createXBLToken,
  DataProvider,
  nextUUID,
} from './utils'
import { resolve } from 'path'
import * as C from './Constants'
import Axios from 'axios'
import JWT from 'jsonwebtoken'
import zlib from 'zlib'

import {
  Client,
  PacketReliability,
  PacketPriority,
} from 'raknet-native'

const host = "20.81.19.143"
const port = 30018

// Overrides Console Methods To Add Log History
overrideProcessConsole(resolve(process.cwd(), 'logs'))

import AuthHandler from './auth'
const auth = new AuthHandler({
  clientId: C.AzureClientID,
  authority: C.AuthEndpoints.MSALAuthority,
  cacheDir: resolve(process.cwd(), 'msal-cache'),
})

auth.createApp(auth.createConfig())

import * as crypto from 'crypto'

import {
  createDeserializer, createSerializer, 
} from './raknet/Serializer'
const SALT = '🧂'
const curve = 'secp384r1'

const ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: curve })
const publicKeyDER = ecdhKeyPair.publicKey.export({
  format: 'der',
  type: 'spki',
})
const privateKeyPEM = ecdhKeyPair.privateKey.export({
  format: 'pem',
  type: 'sec1',
})
const clientX509 = publicKeyDER.toString('base64')

const dataProvider = new DataProvider(C.Versions[C.CUR_VERSION])

import { types } from 'protodef'
const [readVarInt] = types.varint

auth.selectUser()
  .then(async res => {
    const result = await auth.ezXSTSForRealmRak(res)
    Axios({
      method: 'post',
      url: C.AuthEndpoints.MinecraftAuth,
      headers: C.MinecraftAuthHeaders(createXBLToken(result)),
      data: {
        identityPublicKey: clientX509,
      },
    })
      .then(({ data }) => {
        const privateKey = ecdhKeyPair.privateKey
        const clientIdentityChain = JWT.sign({
          identityPublicKey: "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8ELkixyLcwlZryUQcu1TvPOmI2B7vX83ndnWRUaXm74wFfa5f/lwQNTfrLVHa2PmenpGI6JhIMUJaWZrjmMj90NoKNFSNBuKdm8rYiXsfaz3K36x/1U26HpG0ZxK/V1V",
          certificateAuthority: true,
        }, privateKey as unknown as JWT.Secret, {
          algorithm: 'ES384',
          header: {
            x5u: clientX509,
            // typ: undefined,
            alg: 'ES384',
          }, 
        })
        // console.log(clientIdentityChain)
        const userData: string = data.chain[1]
        const payld = userData.split(".").map(d => Buffer.from(d, 'base64'))[1]
        const xboxProfile: { extraData: { displayName: string } } = JSON.parse(String(payld))

        // console.log(xboxProfile)
        const skinData = JSON.parse(dataProvider.getVersionMap().getData('steve.json')
          .toString('utf-8'))

        const skd = dataProvider.getVersionMap().getData('steveSkin.bin')
          .toString('base64')
        const geo = dataProvider.getVersionMap().getData('steveGeometry.json')
          .toString('base64')
        const payload = {
          ...skinData,

          ClientRandomId: Date.now(),
          CurrentInputMode: 1,
          DefaultInputMode: 1,
          DeviceId: nextUUID(),
          DeviceModel: 'PrismarineJS',
          DeviceOS: 7,
          GameVersion: C.CUR_VERSION,
          GuiScale: -1,
          LanguageCode: 'en_GB',
          PlatformOfflineId: '',
          PlatformOnlineId: '',
          PlayFabId: nextUUID().replace(/-/g, "")
            .slice(0, 16),
          SelfSignedId: nextUUID(),
          ServerAddress: `${host}:${port}`,
          SkinData: skd,
          SkinGeometryData: geo,
          
          ThirdPartyName: xboxProfile.extraData.displayName,
          ThirdPartyNameOnly: false,
          UIProfile: 0,
        }

        const clientUserChain = JWT.sign(payload, privateKey as unknown as JWT.Secret, {
          algorithm: 'ES384',
          header: {
            x5u: clientX509,
            // typ: undefined,
            alg: 'ES384',
          },
          noTimestamp: true,
        })

        const chain = [
          clientIdentityChain,
          ...data.chain,
        ]
        // console.log(chain)

        const encodedChain = JSON.stringify({ chain })

        const serializer = createSerializer("1.17.10")
        const deserializer = createDeserializer("1.17.10")

        const loginPayload = {
          protocol_version: C.Versions[C.CUR_VERSION],
          tokens: {
            identity: encodedChain,
            client: clientUserChain,
          },
        }

        const raknet = new Client(host, port, { protocolVersion: 10 })
        raknet.on('connect', (d) => {
          console.log("Raknet Connected With Data", d)
          const spak = serializer.createPacketBuffer({
            name: 'login',
            params: loginPayload, 
          })
          const defpak = zlib.deflateRawSync(spak as Buffer, { level: 7 })
          const ret = Buffer.concat([Buffer.from([0xfe]), defpak])
          console.log(ret)
          raknet.send(ret, PacketPriority.HIGH_PRIORITY, PacketReliability.RELIABLE_ORDERED, 0)
        })

        raknet.on('encapsulated', (arg) => {
          // console.log(arg.buffer)
          const buf = Buffer.from(arg.buffer)
          console.log(buf)
          if (buf[0] !== 0xfe) throw Error('bad batch packet header ' + buf[0])
          const buffer = buf.slice(1)
          const inf = zlib.inflateRawSync(buffer, { chunkSize: 1024 * 1024 * 2 })
          const packets = []
          let offset = 0
          while (offset < inf.byteLength) {
            const { value, size } = readVarInt(inf, offset) as { value: number, size: number }
            const dec = Buffer.allocUnsafe(value)
            offset += size
            offset += inf.copy(dec, 0, offset, offset + value)
            packets.push(dec)
          }
          for (const packet of packets) {
            const des: { data: { name: unknown, params: unknown } } = deserializer.parsePacketBuffer(packet) as { data: { name: unknown, params: unknown } }
            const pakData = {
              name: des.data.name,
              params: des.data.params, 
            }
            console.log(pakData)
          }
        })

        raknet.on('pong', (...args) => {
          console.log('Raknet Pong', args)
        })

        raknet.connect()

      })
  })
