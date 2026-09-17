<script lang="tsx" setup>
import { systemTitle } from '@/base'

interface Props {
  transparent?: boolean
  hasBorder?: boolean
}
withDefaults(
  defineProps<Props>(),
  {
    transparent: true,
    hasBorder: true
  }
)

</script>

<template>
  <header
    class="navigation-nav-header-container"
    :class="[
      transparent
        ? 'navigation-nav-header-container--glass'
        : 'navigation-nav-header-container--plain',
      hasBorder
        ? 'navigation-nav-header-container--bordered'
        : 'navigation-nav-header-container--borderless'
    ]"
  >
    <div
      class="header-left"
    >
      <div
        class="brand-entry"
        select-none
        cursor-pointer
      >
        <div class="brand-mark">
          <span class="brand-mark__core"></span>
        </div>
        <div class="brand-copy">
          <div class="brand-title">{{ systemTitle }}</div>
          <div class="brand-subtitle">智能工作台</div>
        </div>
      </div>
    </div>
    <div class="header-center">
      <div
        class="header-center__content"
      >
        <slot name="bottom"></slot>
      </div>
    </div>

    <div class="header-right">
      <slot name="right"></slot>
    </div>
  </header>
</template>

<style lang="scss" scoped>

.navigation-nav-header-container {
  --at-apply: w-full items-center justify-center;
  --at-apply: px-12 py-8;
  --at-apply: lt-lg:flex-col;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;

  border: 1px solid rgb(155 176 255 / 18%);
  border-radius: 24px;
  background: linear-gradient(180deg, rgb(255 255 255 / 70%), rgb(246 249 255 / 62%));
  box-shadow:
    0 18px 44px rgb(58 80 138 / 8%),
    inset 0 1px 0 rgb(255 255 255 / 72%);
  backdrop-filter: blur(18px);

  .header-left,
  .header-center,
  .header-right {
    --at-apply: flex items-center h-full text-16;
  }

  .header-left {
    --at-apply: h-50px;
    justify-self: start;
  }

  .header-right {
    --at-apply: flex items-center h-full text-16;
    justify-self: end;
  }

  .header-center {
    justify-self: center;
    min-width: 0;
  }

  .header-center__content {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 36px;
  }
}

.brand-entry {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.navigation-nav-header-container--plain {
  background: transparent;
}

.navigation-nav-header-container--borderless {
  padding: 0;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.brand-mark {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background:
    linear-gradient(135deg, rgb(103 134 255 / 24%), rgb(69 209 255 / 18%));
  border: 1px solid rgb(124 149 255 / 20%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 75%);

  &::before,
  &::after {
    position: absolute;
    content: '';
    inset: 10px;
    border-radius: 10px;
    border: 1px solid rgb(105 132 255 / 22%);
  }

  &::after {
    inset: 16px;
    border-radius: 999px;
    border-color: rgb(75 204 242 / 36%);
  }
}

.brand-mark__core {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, #5f7cff 0%, #47d4ff 100%);
  box-shadow: 0 0 0 6px rgb(95 124 255 / 10%);
  transform: translate(-50%, -50%);
}

.brand-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.brand-title {
  color: #18253d;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.2;
}

.brand-subtitle {
  margin-top: 3px;
  color: #7283a0;
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
