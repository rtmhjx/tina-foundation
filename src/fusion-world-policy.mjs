/** Known historical phone World policy, used only when the archive lacks it.
 * coo-mobile 0.3.33-beta.1 declares pet_touch as piggyback and messages as flush.
 * This does not infer identity or authority from external message text.
 */
export function isHistoricalPassivePhoneTouch(event) {
  return ['coo_mobile', 'milkcoo-app', 'milkcoo_app'].includes(event?.source)
    && event.type === 'coo_mobile.pet_touch' && event.origin === 'external';
}

export function archiveDeliveryTrigger(event) {
  if (event.deliveryTrigger !== undefined) return event.deliveryTrigger === 'piggyback' ? 'piggyback' : 'flush';
  return isHistoricalPassivePhoneTouch(event) ? 'piggyback' : 'flush';
}
