import Vue from "vue";
import Router from "vue-router";
import Wallet from "@/views/Wallet.vue";
import WalletAccount from "@/views/WalletAccount.vue";
import BridgeAccount from "@/views/BridgeAccount.vue";
import Tokens from "@/views/Tokens.vue";
import Relays from "@/views/Relays.vue";
import RelayDetail from "@/views/RelayDetail.vue";
import PageNotFound from "@/views/PageNotFound.vue";
import HeroConvert from "@/components/hero/sub/HeroConvert.vue";
import HeroTransfer from "@/components/hero/sub/HeroTransfer.vue";
import HeroBridge from "@/components/hero/sub/HeroBridge.vue";
import HeroRelay from "@/components/hero/sub/HeroRelay.vue";
import HeroCreate from "@/components/hero/sub/HeroCreate.vue";
import Navigation from "@/components/layout/Navigation.vue";
import Privacy from "@/components/common/Privacy.vue";
import {Feature, services} from "@/api/helpers";
import Bridge from "@/views/Bridge.vue";

Vue.use(Router);

export const defaultModule = "tlos";
const PREFERRED_SERVICE = "preferredService";

export const router = new Router({
  mode: "history",
  base: process.env.BASE_URL,
  linkExactActiveClass: "active",
  scrollBehavior(to, from, savedPosition) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (savedPosition) {
          resolve(savedPosition);
        } else {
          resolve({ x: 0, y: 0 });
        }
      }, 500);
    });
  },
  routes: [
    {
      path: "/privacy",
      name: "Privacy",
      components: {
        Nav: Navigation,
        default: Privacy
      }
    },
    {
      path: "/404",
      name: "404",
      components: {
        Nav: Navigation,
        default: PageNotFound
      }
    },
    {
      path: "/:service/create",
      name: "Create",
      components: {
        Nav: Navigation,
        Hero: HeroCreate
      }
    },
    {
      path: "/:service/transfer/:id",
      name: "Transfer",
      components: {
        Nav: Navigation,
        default: WalletAccount,
        Hero: HeroTransfer
      },
      props: true
    },
    {
      path: "/:service/wallet",
      name: "Wallet",
      components: {
        Nav: Navigation,
        default: Wallet
      }
    },
    {
      path: "/:service/wallet/:account",
      name: "WalletAccount",
      components: {
        Nav: Navigation,
        Hero: HeroTransfer,
        default: WalletAccount
      },
      props: true
    },
    {
      path: "/:service/bridge/:id",
      name: "Bridge",
      components: {
        Nav: Navigation,
        default: BridgeAccount,
        Hero: HeroBridge
      },
      props: true,
      meta: {
        feature: "Bridge"
      }
    },
    {
      path: "/:service/bridge/:account",
      name: "BridgeAccount",
      components: {
        Nav: Navigation,
        Hero: HeroBridge,
        default: BridgeAccount
      },
      props: true,
      meta: {
        feature: "Bridge"
      }
    },
    {
      path: "/:service/pools",
      name: "Relays",
      components: {
        Nav: Navigation,
        default: Relays,
        Hero: HeroRelay
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "/:service/pool/:account/detail",
      name: "RelayDetail",
      components: {
        Nav: Navigation,
        default: RelayDetail,
        Hero: HeroRelay
      },
      props: true
    },
    {
      path: "/:service/pool/:account",
      name: "Relay",
      components: {
        Nav: Navigation,
        default: Relays,
        Hero: HeroRelay
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "/:service",
      name: "Tokens",
      components: {
        Nav: Navigation,
        default: Tokens,
        Hero: HeroConvert
      },
      props: true,
      meta: {
        feature: "Trade"
      }
    },
    {
      path: "*",
      redirect: `/${defaultModule}`
    },
    {
      path: "/",
      redirect: () => {
        const preferredService = localStorage.getItem(PREFERRED_SERVICE);
        if (preferredService) {
          const foundService = services.find(
            service => service.namespace == preferredService
          );
          if (foundService) return `/${foundService.namespace}`;
        }
        return `/${defaultModule}`;
      }
    }
  ]
});

const setPreferredService = (service: string) => {
  localStorage.setItem(PREFERRED_SERVICE, service);
};

router.beforeEach((to, from, next) => {
  if (to.meta && to.meta.feature) {
    const service = services.find(
      service => service.namespace == to.params.service
    )!;
    if (!service) {
      next("/404");
      return;
    }
    setPreferredService(service.namespace);
    switch (to.meta.feature) {
      case "Trade":
        if (service.features.includes(Feature.Trade)) next();
        else next("/404");
        break;
      case "Liquidity":
        if (service.features.includes(Feature.Liquidity)) next();
        else next("/404");
        break;
      case "Bridge":
        if (service.features.includes(Feature.Bridge)) next();
        else next("/404");
        break;
      default:
        next();
    }
  } else {
    next();
  }
});
