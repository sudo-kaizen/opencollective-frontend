import React from 'react';
import PropTypes from 'prop-types';
import { FormattedMessage, FormattedDate, defineMessages, injectIntl } from 'react-intl';
import { get } from 'lodash';
import { Flex } from '@rebass/grid';
import memoizeOne from 'memoize-one';

import Container from '../Container';
import StyledButtonSet from '../StyledButtonSet';
import StyledInputField from '../StyledInputField';
import StyledSelect from '../StyledSelect';
import { P, Span } from '../Text';
import Currency from '../Currency';
import StyledInputAmount from '../StyledInputAmount';
import StyledInput from '../StyledInput';
import { getNextChargeDate } from '../../lib/date-utils';

const FrequenciesI18n = defineMessages({
  oneTime: {
    id: 'Frequency.OneTime',
    defaultMessage: 'One time',
  },
  month: {
    id: 'Frequency.Monthly',
    defaultMessage: 'Monthly',
  },
  year: {
    id: 'Frequency.Year',
    defaultMessage: 'Yearly',
  },
});

const getOption = (intl, interval) => {
  return {
    value: interval,
    label: intl.formatMessage(FrequenciesI18n[interval]),
  };
};

const generateOptions = memoizeOne(intl => {
  return Object.keys(FrequenciesI18n).map(interval => getOption(intl, interval));
});

const getChangeFromState = state => ({
  amount: state.amount,
  quantity: state.quantity,
  totalAmount: state.amount * (state.quantity || 1),
  interval: state.interval === 'oneTime' ? null : state.interval,
});

/** Build a map of display props for the options */
const buildDisplayMap = options => {
  return options.reduce((map, value, idx) => {
    // Ensure first and last values are always displayed
    if (idx === 0 || idx === options.length - 1 || Object.keys(map).length < 2) {
      map[value] = 'block';
    } else if (Object.keys(map).length < 4) {
      // Limit to 3 on mobile
      map[value] = ['none', 'block'];
    } else {
      // Never show more than 5 options
      map[value] = 'none';
    }

    return map;
  }, {});
};

const StepDetails = ({
  amountOptions,
  currency,
  disabledInterval,
  disabledAmount,
  minAmount,
  amount,
  interval,
  quantity,
  maxQuantity,
  showQuantity,
  showInterval,
  customFields,
  customData,
  onChange,
  onCustomFieldsChange,
  intl,
}) => {
  const hasOptions = get(amountOptions, 'length', 0) > 0;
  const displayMap = amountOptions ? buildDisplayMap(amountOptions) : {};
  const dispatchChange = values => onChange(getChangeFromState({ amount, interval, quantity, ...values }));
  const intervalOptions = generateOptions(intl);
  interval = interval || 'oneTime';

  return (
    <Flex width={1} flexDirection={hasOptions ? 'column' : 'row'} flexWrap="wrap">
      <Flex mb={3}>
        {hasOptions && (
          <StyledInputField
            label={
              <FormattedMessage
                id="contribution.amount.currency.label"
                values={{ currency }}
                defaultMessage="Amount ({currency})"
              />
            }
            htmlFor="amount"
            css={{ flexGrow: 1 }}
            disabled={disabledAmount}
          >
            {fieldProps => (
              <StyledButtonSet
                {...fieldProps}
                combo
                items={amountOptions}
                selected={amount}
                onChange={amount => dispatchChange({ amount })}
                buttonPropsBuilder={({ item }) => ({ display: displayMap[item] })}
              >
                {({ item }) => <Currency value={item} currency={currency} />}
              </StyledButtonSet>
            )}
          </StyledInputField>
        )}
        <Container minWidth={100} maxWidth={120} mr={!hasOptions && 3}>
          <StyledInputField
            label={
              hasOptions ? (
                <FormattedMessage id="contribution.amount.other.label" defaultMessage="Other" />
              ) : (
                <FormattedMessage
                  id="contribution.amount.currency.label"
                  values={{ currency }}
                  defaultMessage="Amount ({currency})"
                />
              )
            }
            htmlFor="custom-amount"
            disabled={disabledAmount}
          >
            {fieldProps => (
              <StyledInputAmount
                type="number"
                currency={currency}
                min={minAmount / 100}
                {...fieldProps}
                value={amount / 100}
                width={1}
                onChange={({ target }) => dispatchChange({ amount: Math.round(parseFloat(target.value) * 100) })}
                containerProps={{ borderRadius: hasOptions ? '0 4px 4px 0' : 3, ml: '-1px' }}
                prependProps={{ pl: 2, pr: 0, bg: 'white.full', color: 'black.800' }}
                px="2px"
              />
            )}
          </StyledInputField>
        </Container>
        {showQuantity && (
          <StyledInputField
            htmlFor="quantity"
            label={<FormattedMessage id="contribution.quantity" defaultMessage="Quantity" />}
            ml={2}
          >
            {fieldProps => (
              <StyledInput
                type="number"
                min={1}
                max={maxQuantity}
                {...fieldProps}
                value={quantity}
                width={1}
                maxWidth={80}
                onChange={({ target }) => dispatchChange({ quantity: parseInt(target.value) })}
                mr={3}
              />
            )}
          </StyledInputField>
        )}
      </Flex>

      {showInterval && (
        <StyledInputField
          label={<FormattedMessage id="contribution.interval.label" defaultMessage="Frequency" />}
          htmlFor="interval"
        >
          {({ id }) => (
            <Flex alignItems="center">
              <StyledSelect
                id={id}
                options={intervalOptions}
                value={getOption(intl, interval)}
                onChange={({ value }) => dispatchChange({ interval: value })}
                isSearchable={false}
                minWidth={150}
                disabled={disabledInterval}
              />
              {interval !== 'oneTime' && (
                <P color="black.500" ml={3}>
                  <FormattedMessage id="contribution.subscription.first.label" defaultMessage="First charge:" />{' '}
                  <Span color="primary.500">
                    <FormattedMessage id="contribution.subscription.today" defaultMessage="Today" />
                  </Span>
                  <br />
                  <FormattedMessage id="contribution.subscription.next.label" defaultMessage="Next charge:" />{' '}
                  <Span color="primary.500">
                    <FormattedDate
                      value={getNextChargeDate(new Date(), interval)}
                      day="numeric"
                      month="short"
                      year="numeric"
                    />
                  </Span>
                </P>
              )}
            </Flex>
          )}
        </StyledInputField>
      )}
      {customFields &&
        customFields.length > 0 &&
        customFields.map(customField => {
          const value = customData && customData[customField.name] ? customData[customField.name] : '';
          return (
            <StyledInputField mt={2} key={customField.name} htmlFor={customField.name} label={customField.label}>
              {fieldProps => (
                <StyledInput
                  type={customField.type}
                  {...fieldProps}
                  value={value}
                  width={1}
                  required={customField.required}
                  onChange={({ target }) => onCustomFieldsChange(customField.name, target.value)}
                />
              )}
            </StyledInputField>
          );
        })}
    </Flex>
  );
};

StepDetails.propTypes = {
  /**
   * The list of amounts that user can pick directly. If not provided, only the
   * custom input will be shown. Note that the number of items actually displayed
   * may vary from the list length as we limit the number of options displayed,
   * especially on mobile.
   */
  amountOptions: PropTypes.arrayOf(PropTypes.number),
  currency: PropTypes.string.isRequired,
  onChange: PropTypes.func,
  /** If true, the select for interval will be disabled */
  disabledInterval: PropTypes.bool,
  /** If true, the input for amount will be disabled */
  disabledAmount: PropTypes.bool,
  /** value for frequency select, defaults to one time. */
  interval: PropTypes.string,
  /** value for amount options, defaults to the first option */
  amount: PropTypes.number,
  /** value for quantity */
  quantity: PropTypes.number,
  /** max number of items that user can order */
  maxQuantity: PropTypes.number,
  /** Min amount in cents */
  minAmount: PropTypes.number,
  /** Enable the quantity input */
  showQuantity: PropTypes.bool,
  /** Enable the interval input */
  showInterval: PropTypes.bool,
  /** Enable the customFields inputs */
  customFields: PropTypes.array,
  customData: PropTypes.object,
  intl: PropTypes.object,
  onCustomFieldsChange: PropTypes.func,
};

StepDetails.defaultProps = {
  onChange: () => {},
  disabledInterval: false,
  disabledAmount: false,
  showQuantity: false,
  showInterval: true,
  interval: null,
  minAmount: 100,
  quantity: 1,
};

export default injectIntl(StepDetails);
