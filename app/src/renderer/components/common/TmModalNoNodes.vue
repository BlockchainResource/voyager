<template lang="pug">
.tm-modal-error__wrapper
  .tm-modal-error
    .tm-modal-error__icon: i.material-icons sync_problem
    .tm-modal-error__title No nodes found
    .tm-modal-error__body All known nodes are offline or incompatible. You can retry to connect or switch to a demo connection so you can try out Voyager.
    .tm-modal-error__footer
      tm-btn#tm-modal-error__btn-retry(
        size="lg"
        icon="autorenew"
        color="primary"
        value="Retry Connection"
        @click.native="retry")
      tm-btn#tm-modal-error__btn-mock(
        size="lg"
        icon="pageview"
        value="Try Demo"
        @click.native="useMock")
</template>

<script>
import { ipcRenderer } from "electron"
import { TmBtn } from "@tendermint/ui"
export default {
  name: "modal-no-nodes",
  components: { TmBtn },
  methods: {
    retry() {
      ipcRenderer.send("retry-connection")
      this.$store.commit("setModalNoNodes", false)
    },
    useMock() {
      this.$store.dispatch("setMockedConnector", true)
      this.$store.commit("setModalNoNodes", false)
    }
  }
}
</script>

<style lang="stylus">
@import '~variables'

.tm-modal-error__wrapper
  position absolute
  top 0
  left 0
  z-index z(modalError)
  background var(--app-bg)
  width 100vw
  height 100vh
  max-width 100%
  display flex
  align-items center
  justify-content center

.tm-modal-error
  padding 1.5rem
  max-width 40rem

.tm-modal-error__icon
  position fixed
  top 0
  left 0
  z-index z(below)

  i.material-icons
    font-size 25vw + 25vh
    line-height 1
    color var(--bc-dim)

.tm-modal-error__title
  font-size h1
  font-weight 500
  line-height 1
  margin-bottom 1.5rem

.tm-modal-error__body
  font-size lg
  color var(--dim)
  margin-bottom 3rem

.tm-modal-error__footer
  .tm-btn
    width 100%
    margin-right 1.5rem
    margin-bottom 1rem
    max-width 14rem

    &:last-child
      margin-bottom 0

@media screen and (min-width: 768px)
  .tm-modal-error__icon i.material-icons
    font-size 20vw + 20vh

  .tm-modal-error__body
    margin-bottom 4.5rem

  .tm-modal-error__footer
    min-width 31rem

  .tm-modal-error__footer .tm-btn
    margin-bottom 0
</style>
