import useConnection from '@/application/connection/useConnection'
import useToken from '@/application/token/useToken'
import useWallet from '@/application/wallet/useWallet'
import { shakeUndifindedItem } from '@/functions/arrayMethods'
import jFetch from '@/functions/dom/jFetch'
import { toHumanReadable } from '@/functions/format/toHumanReadable'
import toPubString, { toPub } from '@/functions/format/toMintString'
import { areShallowEqual } from '@/functions/judgers/areEqual'
import { gt } from '@/functions/numberish/compare'
import { useEffectWithTransition } from '@/hooks/useEffectWithTransition'
import { useRecordedEffect } from '@/hooks/useRecordedEffect'
import { HexAddress } from '@/types/constants'
import { LiquidityPoolsJsonFile } from '@raydium-io/raydium-sdk'
import { useEffect } from 'react'
import { hydrateIdoInfo } from '../ido/hydrateIdoInfo'
import { getUserTokenEvenNotExist } from '../token/getUserTokenEvenNotExist'
import hydrateLiquidityInfo from './hydrateLiquidityInfo'
import sdkParseJsonLiquidityInfo from './sdkParseJsonLiquidityInfo'
import useLiquidity from './useLiquidity'

/**
 * will load liquidity info (jsonInfo, sdkParsedInfo, hydratedInfo)
 */
export default function useLiquidityInfoLoader({ disabled }: { disabled?: boolean } = {}) {
  const {
    jsonInfos,
    sdkParsedInfos,
    currentJsonInfo,
    currentSdkParsedInfo,
    userExhibitionLiquidityIds,
    hydratedInfos
  } = useLiquidity()
  const getToken = useToken((s) => s.getToken)
  const getLpToken = useToken((s) => s.getLpToken)
  const isLpToken = useToken((s) => s.isLpToken)
  const refreshCount = useLiquidity((s) => s.refreshCount)
  const connection = useConnection((s) => s.connection)
  const pureRawBalances = useWallet((s) => s.pureRawBalances)

  /** fetch json info list  */
  useEffectWithTransition(async () => {
    if (disabled) return
    const response = await jFetch<LiquidityPoolsJsonFile>('https://api.raydium.io/v2/sdk/liquidity/mainnet.json', {
      ignoreCache: true
    })
    const blacklist = await jFetch<HexAddress[]>('/amm-blacklist.json')
    const liquidityInfoList = [...(response?.official ?? []), ...(response?.unOfficial ?? [])]
      // no raydium blacklist amm
      .filter((info) => !(blacklist ?? []).includes(info.id))
    const officialIds = new Set(response?.official?.map((i) => i.id))
    const unOfficialIds = new Set(response?.unOfficial?.map((i) => i.id))
    if (liquidityInfoList) useLiquidity.setState({ jsonInfos: liquidityInfoList, officialIds, unOfficialIds })
  }, [disabled])

  /** get userExhibitionLiquidityIds */
  useEffectWithTransition(async () => {
    // when refresh, it will refresh twice. one for rawBalance, one for liquidityRefreshCount
    if (disabled) return
    if (!jsonInfos) return
    const liquidityLpMints = new Set(jsonInfos.map((jsonInfo) => jsonInfo.lpMint))
    const allLpBalance = Object.entries(pureRawBalances).filter(
      ([mint, tokenAmount]) => liquidityLpMints.has(mint) && gt(tokenAmount, 0)
    )
    const allLpBalanceMint = allLpBalance.map(([mint]) => mint)
    const userExhibitionLiquidityIds = jsonInfos
      .filter((jsonInfo) => allLpBalanceMint.includes(jsonInfo.lpMint))
      .map((jsonInfo) => jsonInfo.id)

    useLiquidity.setState({ userExhibitionLiquidityIds })
  }, [disabled, jsonInfos, pureRawBalances, isLpToken, refreshCount])

  /** json infos ➡ sdkParsed infos (only wallet's LP)  */
  useRecordedEffect(
    async ([prevDisabled, prevConnection, prevJsonInfos, prevUserExhibitionLiquidityIds, prevRefreshCount]) => {
      if (disabled) return
      if (!connection || !jsonInfos.length || !userExhibitionLiquidityIds.length) return

      if (
        prevRefreshCount == refreshCount &&
        areShallowEqual(prevUserExhibitionLiquidityIds, userExhibitionLiquidityIds)
      )
        return

      const sdkParsedInfos = await sdkParseJsonLiquidityInfo(
        jsonInfos.filter((i) => userExhibitionLiquidityIds.includes(i.id)),
        connection
      )

      // load

      useLiquidity.setState({ sdkParsedInfos: shakeUndifindedItem(sdkParsedInfos) })
    },
    [disabled, connection, jsonInfos, userExhibitionLiquidityIds, refreshCount] as const
  )

  /** sdkParsed infos (only wallet's LP) ➡  hydrated infos (only wallet's LP)*/
  useEffectWithTransition(async () => {
    if (disabled) return
    const hydratedInfos = sdkParsedInfos.map((liquidityInfo) =>
      hydrateLiquidityInfo(liquidityInfo, {
        getToken,
        getLpToken,
        lpBalance: pureRawBalances[toPubString(liquidityInfo.lpMint)]
      })
    )
    useLiquidity.setState({ hydratedInfos })
  }, [disabled, sdkParsedInfos, pureRawBalances, getToken, getLpToken])

  // record id to userAddedTokens
  useRecordedEffect(
    ([prevHydratedInfos]) => {
      const areHydratedIdsNotChanged =
        prevHydratedInfos &&
        areShallowEqual(
          prevHydratedInfos?.map((i) => toPubString(i.id)),
          hydratedInfos.map((i) => toPubString(i.id))
        )
      if (areHydratedIdsNotChanged) return
      const recordedHydratedInfos = hydratedInfos.map((i) => {
        getUserTokenEvenNotExist(i.baseMint)
        getUserTokenEvenNotExist(i.quoteMint)
        return hydrateLiquidityInfo(i, {
          getToken,
          getLpToken,
          lpBalance: pureRawBalances[toPubString(i.lpMint)]
        })
      })
      useLiquidity.setState({ hydratedInfos: recordedHydratedInfos })
    },
    [hydratedInfos]
  )

  /** CURRENT jsonInfo ➡ current sdkParsedInfo  */
  useEffectWithTransition(async () => {
    if (disabled) return
    if (connection && currentJsonInfo) {
      useLiquidity.setState({
        currentSdkParsedInfo: (await sdkParseJsonLiquidityInfo([currentJsonInfo], connection))?.[0]
      })
    } else {
      useLiquidity.setState({ currentSdkParsedInfo: undefined })
    }
  }, [disabled, currentJsonInfo, connection, refreshCount])

  /** CURRENT sdkParsedInfo ➡ current hydratedInfo  */
  useEffectWithTransition(async () => {
    if (disabled) return
    if (connection && currentSdkParsedInfo) {
      const lpBalance = pureRawBalances[String(currentSdkParsedInfo.lpMint)]
      const hydrated = await hydrateLiquidityInfo(currentSdkParsedInfo, { getToken, getLpToken, lpBalance })
      useLiquidity.setState({
        currentHydratedInfo: hydrated
      })
    } else {
      useLiquidity.setState({ currentHydratedInfo: undefined })
    }
  }, [disabled, currentSdkParsedInfo, getToken, getLpToken])
}
