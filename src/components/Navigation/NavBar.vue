<script lang="tsx" setup>
import brandLogoUrl from '@/assets/images/logo_AI.png'
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
          <img
            class="brand-mark__avatar"
            :src="brandLogoUrl"
            alt="品牌 Logo"
          >
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 1px;
  overflow: hidden;
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgb(112 140 255 / 28%), rgb(68 210 255 / 18%));
  border: 1px solid rgb(136 160 255 / 28%);
  box-shadow:
    0 10px 24px rgb(49 69 122 / 12%),
    inset 0 1px 0 rgb(255 255 255 / 76%);

  &::after {
    position: absolute;
    inset: 1px;
    content: '';
    border-radius: 13px;
    border: 1px solid rgb(255 255 255 / 26%);
    pointer-events: none;
  }
}

.brand-mark__avatar {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 12px;
  // 这张 Logo 原图留白偏多，轻微放大能让头像在容器里更饱满。
  transform: scale(1.14);
  filter: saturate(1.05) contrast(1.04);
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
