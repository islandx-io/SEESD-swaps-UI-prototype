import { createModule, mutation, action } from "vuex-class-component";
import { vxm } from "@/store/index";
import { store } from "../../../store";

const VuexModule = createModule({
  strict: false
});

export class WalletModule extends VuexModule.With({ namespaced: "wallet/" }) {
  get currentWallet() {
    return vxm.bancor.wallet;
  }

  get currentNetwork() {
    // @ts-ignore
    return store.state.routeModule.params.service;
  }

  get isAuthenticated() {
    // @ts-ignore
    return vxm[`${vxm.bancor.wallet}Wallet`].isAuthenticated;
  }

  @action async dispatcher(methodName: string, params: any = null) {
    return params
      ? this.$store.dispatch(`${this.currentWallet}/${methodName}`, params)
      : this.$store.dispatch(`${this.currentWallet}/${methodName}`);
  }

  @action async tx(actions: any[]) {
    return this.dispatcher("tx", actions);
  }

  @action async initLogin() {
    return this.dispatcher("initLogin");
  }

  @action async logout() {
    return this.dispatcher("logout");
  }
}
