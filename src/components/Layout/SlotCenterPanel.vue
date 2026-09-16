<script lang="ts" setup>
interface Props {
  loading?: boolean
}
withDefaults(
  defineProps<Props>(),
  {
    loading: false
  }
)
</script>

<template>
  <LayoutSlotFrame
    :class="[
      'bg-no-repeat bg-cover bg-center slot-center-panel-shell',
    ]"
  >
    <template #center>
      <div
        w-full
        h-full
        overflow-hidden
        class="panel-shadow"
      >
        <n-spin
          w-full
          h-full
          content-class="w-full h-full flex"
          :show="loading"
          :rotate="false"
          class="slot-center-panel"
          :style="{
            '--n-opacity-spinning': '0'
          }"
        >
          <template #icon>
            <div class="i-svg-spinners:pulse-3"></div>
          </template>
          <section
            v-if="$slots.left"
            flex="~ col"
            w-300
            h-full
            overflow-hidden
          >
            <slot name="left"></slot>
          </section>
          <section
            flex="1"
            h-full
            overflow-hidden
          >
            <slot name="default"></slot>
          </section>
        </n-spin>
      </div>
    </template>
    <template #bottom>
      <NavigationNavFooter />
    </template>
  </LayoutSlotFrame>
</template>

<style lang="scss" scoped>
.slot-center-panel-shell {
  background:
    radial-gradient(circle at top left, rgb(98 126 255 / 10%), transparent 24%),
    radial-gradient(circle at bottom right, rgb(70 208 255 / 10%), transparent 24%),
    linear-gradient(180deg, #f5f8ff 0%, #eff4fb 100%);
}

.panel-shadow {
  --shadow: 0 32px 90px rgb(39 58 102 / 10%);
  --at-apply: "shadow-[--shadow]";

  border: 1px solid rgb(163 183 255 / 12%);
  border-radius: 30px;
}

.slot-center-panel {
  background: linear-gradient(180deg, rgb(255 255 255 / 72%), rgb(247 250 255 / 88%));
  backdrop-filter: blur(20px);
}
</style>
