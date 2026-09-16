<script lang="ts" setup>
interface Props {
  active?: boolean
}
withDefaults(
  defineProps<Props>(),
  {
    active: false
  }
)


const emit = defineEmits([
  'click',
  'edit',
  'remove'
])
</script>

<template>
  <div
    flex="~ justify-between"
    py="12px"
    px="14px"
    rounded-14px
    cursor-pointer
    class="sidebar-item group font-bold transition-all-260 b b-solid"
    :class="[
      active
        ? 'sidebar-item--active c-#26415f b-transparent'
        : 'sidebar-item--idle c-#303133 b-transparent'
    ]"
    @click="emit('click')"
  >
    <div
      flex="1"
      text-nowrap
      text-ellipsis
      overflow-x-hidden
      pr-6px
    >
      <slot></slot>
    </div>
    <div
      class="sidebar-item__action opacity-0 transition-all-200 text-16"
      px="4"
      :class="[
        active
          ? 'opacity-100 c-#5677b0 hover:c-#35558f'
          : 'group-hover:opacity-100 c-#7a879d hover:c-#35558f'
      ]"
      flex="~ justify-center items-center"
      @click.stop="emit('edit')"
    >
      <div class="i-mingcute:pencil-2-line"></div>
    </div>
    <n-popconfirm
      @positive-click="emit('remove')"
    >
      <template #trigger>
        <div
          class="sidebar-item__action opacity-0 transition-all-200 text-16"
          px="4"
          :class="[
            active
              ? 'opacity-100 c-#5677b0 hover:c-#35558f'
              : 'group-hover:opacity-100 c-#7a879d hover:c-#35558f'
          ]"
          flex="~ justify-center items-center"
          @click.stop
        >
          <div class="i-mingcute:delete-2-line"></div>
        </div>
      </template>
      确认删除？
    </n-popconfirm>
  </div>
</template>

<style lang="scss" scoped>
.sidebar-item {
  border-color: transparent;
  background: rgb(255 255 255 / 42%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 58%);

  &:hover {
    border-color: rgb(151 170 222 / 18%);
    background: rgb(255 255 255 / 72%);
    box-shadow:
      0 10px 22px rgb(53 70 117 / 6%),
      inset 0 1px 0 rgb(255 255 255 / 72%);
    transform: translateY(-1px);
  }
}

.sidebar-item--active {
  background: linear-gradient(180deg, rgb(240 245 255 / 98%), rgb(232 240 255 / 94%));
  box-shadow:
    0 12px 26px rgb(67 88 143 / 8%),
    inset 0 1px 0 rgb(255 255 255 / 86%);
}

.sidebar-item__action {
  width: 26px;
  height: 26px;
  border-radius: 9px;

  &:hover {
    background: rgb(255 255 255 / 72%);
  }
}

</style>
