<script lang="ts" setup>
</script>

<template>
  <LayoutSlotCenterPanel v-bind="$attrs">
    <template
      v-if="$slots.sidebar"
      #left
    >
      <div
        min-h-0
        flex="1 ~ col"
        :class="[
          'select-none',
          'bg-no-repeat bg-cover bg-right',
          'bg-bgcolor'
        ]"
      >
        <div
          v-if="$slots['sidebar-header']"
          py="2px"
        >
          <slot name="sidebar-header"></slot>
        </div>
        <div
          flex="1"
          p="5px"
          overflow-y-auto
          class="sidebar-scroll-area"
        >
          <slot name="sidebar"></slot>
        </div>
        <div
          py="14px"
          px="20px"
        >
          <slot name="sidebar-action"></slot>
        </div>
      </div>
    </template>
    <div
      h-full
      bg="#fefbff"
    >
      <slot name="default"></slot>
    </div>
  </LayoutSlotCenterPanel>
</template>

<style lang="scss" scoped>
.sidebar-scroll-area {
  scrollbar-width: thin;
  scrollbar-color: rgb(133 156 208 / 65%) transparent;

  &::-webkit-scrollbar {
    width: 5px;
    height: 5px;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: linear-gradient(180deg, rgb(176 191 227 / 78%), rgb(129 149 197 / 82%));
  }

  &::-webkit-scrollbar-track {
    border-radius: 999px;
    background: rgb(255 255 255 / 12%);
  }
}
</style>
